import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as mkdirp from "mkdirp";
import { escape, parse } from "querystring";
import { StringLiteralLike } from "typescript";

interface Context {
	sourceFiles: string[],
	checker: ts.TypeChecker,
	rootNameSpace: Namespace,
	closures: Signature[],
}

let diagnosticsHost : ts.FormatDiagnosticsHost = {
	getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
	getNewLine: () => ts.sys.newLine,
	getCanonicalFileName: (filename) => filename
};

function readTsConfig(tsConfigJsonFileName:string, basePath:string) : ts.ParsedCommandLine | undefined {
	let configJson = ts.readConfigFile(tsConfigJsonFileName, ts.sys.readFile);
	if (configJson.error !== undefined) {
		console.error("Failed to read tsconfig.json file \""+tsConfigJsonFileName+"\"!");
		console.error(ts.formatDiagnostic(configJson.error, diagnosticsHost));
		return undefined;
	}
	let config = ts.parseJsonConfigFileContent(configJson, ts.sys, basePath);
	return config;
}

function syntaxKindToName(kind: ts.SyntaxKind) {
    return (<any>ts).SyntaxKind[kind];
}

function indentAdder(writeln: (s:string) => void) : (s:string) => void {
	return (s) => {
		if (s.length == 0) {
			writeln("");
		} else {
			writeln("\t"+s);
		}
	};
}

function emitImplJsSerializeForType(rustName: string, conversionToRef: string, writeln: (s:string) => void) {
	writeln("#[doc(hidden)]");
	writeln("impl ::stdweb::private::JsSerialize for "+rustName+" {");
	writeln("\t#[doc(hidden)]");
	writeln("\tfn _into_js< 'a >( &'a self ) -> ::stdweb::private::SerializedValue< 'a > {");
	writeln("\t\t"+conversionToRef+"._into_js()");
	writeln("\t}");
	writeln("}");
	writeln("");
}

// emits ::stdweb::JsSerialize for a type that is a 1-element tuple with a ::stdweb::Reference in it
function emitRefTypeTraits(rustName: string, writeln: (s:string) => void) {
	emitImplJsSerializeForType(rustName, "self.0", writeln);
}

/**
 * Naming scheme for functions:
 *  - If a function name happens once, just use it.
 *  - If it happens multiple times, put a number next to it equal to its number of arguments.
 *  - If that still generates duplicates, try adding "a", "b", "c", etc. until a unique name is found.
 */
function forEachFunctionWithUniqueNames(list: Function[], cb: (f: Function, name: string) => void) {
	let forbiddenNames = new Set<string>();
	{
		let encounteredSoFar = new Map<string, Function>();
		list.forEach((f) => {
			let prev = encounteredSoFar.get(f.rustName);
			if (prev !== undefined) {
				forbiddenNames.add(f.rustName);
				let nArgs = f.signature.args.length;
				let prevNArgs = prev.signature.args.length;
				if (encounteredSoFar.has(f.rustName+nArgs) || prevNArgs == nArgs) {
					forbiddenNames.add(f.rustName+nArgs);
				} else {
					encounteredSoFar.set(f.rustName+nArgs, f);
				}
			} else {
				encounteredSoFar.set(f.rustName, f);
			}
		});
	}

	list.forEach((f) => {
		if (forbiddenNames.has(f.rustName)) {
			let nArgs = f.signature.args.length;
			if (forbiddenNames.has(f.rustName+nArgs)) {
				let x = 0;
				while (forbiddenNames.has(f.rustName+nArgs+numToAbc(x))) {
					x += 1;
				}
				let name = f.rustName+nArgs+numToAbc(x);
				forbiddenNames.add(name);
				cb(f, name);
			} else {
				let name = f.rustName+nArgs;
				forbiddenNames.add(name);
				cb(f, name);
			}
		} else {
			let name = f.rustName;
			forbiddenNames.add(name);
			cb(f, name);
		}
	})
}

function __resolveFunctionNames(raws: Function[], resolveds: Function[]) : Function[] {
	if (raws.length == resolveds.length) {
		return resolveds;
	} else {
		resolveds.length = 0;
		forEachFunctionWithUniqueNames(raws, (f, uniqueName) => {
			resolveds.push(new Function(uniqueName, f.rustName, f.signature, f.docs));
		});
		return resolveds;
	}
}

function rustifiedTypesAreSame(t1: RustifiedType, t2: RustifiedType, context: Context) : boolean {
	return (t1 == t2 || t1.structName(context.rootNameSpace) == t2.structName(context.rootNameSpace));
}

class ClassOrInterface {
	constructor(public symbol: ts.Symbol, public type: ts.InterfaceType, public namespace: Namespace, public context: Context) {
		this.name = symbol.name;
		this.rustName = escapeRustName(this.name);
		this.directImpls = [];

		this.methods = [];
		this._resolvedMethods = [];
		this.properties = [];
	}

	methods: Function[];
	_resolvedMethods: Function[];
	properties: Variable[];

	addMethod(f:Function, context: Context) {
		for (let existingF of this.methods) {
			if (f.isSameAs(existingF, context)) {
				return;
			}
		}
		this.methods.push(f);
	}

	getResolvedMethods() : Function[] {
		return __resolveFunctionNames(this.methods, this._resolvedMethods);
	}

	pushDirectImpl(i:Interface) {
		for (let ownI of this.directImpls) {
			if (ownI.name == i.name) {
				return;
			}
		}
		this.directImpls.push(i);
	}

	protected emitDocs(writeln: (s:string) => void, context: Context) {
		let docs = this.symbol.getDocumentationComment(context.checker);
		for (const docLine of docs) {
			writeln("/// "+docLine);
		}
	}

	name: string;
	rustName: string;
	directImpls: Interface[];
}

class Class extends ClassOrInterface {
	constructor(public symbol: ts.Symbol, public type: ts.InterfaceType, public namespace: Namespace, public context: Context) {
		super(symbol, type, namespace, context);
		let checker = context.checker;

		this.subClassOfTrait = escapeRustName("__SubClassOf_"+symbol.name);
		this.superClass = undefined;

		this.rustifiedType = {
			fromJsValue: (ns: Namespace, s:string) => ns.getRustPathTo(this.namespace, this.rustName)+"(__js_value_into_reference("+s+", \""+this.rustName+"\"))",
			structName: (ns: Namespace) => ns.getRustPathTo(this.namespace, this.rustName),
			inArgPosName: (ns: Namespace) => "impl "+ns.getRustPathTo(this.namespace, this.subClassOfTrait),
			shortName: this.rustName,
			isNullable: false
		}

		this.constructors = [];
		this._resolvedConstructors = [];
		this.staticFunctions = [];
		this._resolvedStaticFunctions = [];
	}

	subClassOfTrait: string;
	superClass: Class | undefined;
	rustifiedType: RustifiedType;
	private constructors: Function[];
	_resolvedConstructors: Function[];
	private staticFunctions: Function[];
	_resolvedStaticFunctions: Function[];

	addConstructor(f:Function, context: Context) {
		for (let existingF of this.constructors) {
			if (f.isSameAs(existingF, context)) {
				return;
			}
		}
		this.constructors.push(f);
	}

	addStaticMethod(f:Function, context: Context) {
		for (let existingF of this.staticFunctions) {
			if (f.isSameAs(existingF, context)) {
				return;
			}
		}
		this.staticFunctions.push(f);
	}

	getResolvedConstructors() : Function[] {
		return __resolveFunctionNames(this.constructors, this._resolvedConstructors);
	}

	getResolvedStaticFunctions() : Function[] {
		return __resolveFunctionNames(this.staticFunctions, this._resolvedStaticFunctions);
	}

	forEachSuperClass(cb: (i:Class) => void) {
		if (this.superClass !== undefined) {
			this.superClass.forEachSuperClass(cb);
			cb(this.superClass);
		}
	}

	forEachSuperImpl(cb: (i:Interface) => void) {
		let visited = new Set<Interface>();
		function rec(node:ClassOrInterface) {
			for (let i of node.directImpls) {
				if (!visited.has(i)) {
					visited.add(i);
					rec(i);
					cb(i);
				}
			}
		}
		this.forEachSuperClass((c) => { rec(c); });
		rec(this);
	}

	emit(writeln: (s:string) => void, context: Context) : void {
		//console.log(this.methods);
		let checker = context.checker;
		this.emitDocs(writeln, context);
		writeln("pub struct "+this.rustName+"(pub ::stdweb::Reference);");
		writeln("");
		writeln("pub trait "+this.subClassOfTrait+":");
		writeln("\t"+CLASS_BASE_TRAITS+" +");
		if (this.superClass !== undefined) {
			writeln("\t"+this.namespace.getRustPathTo(this.superClass.namespace, this.superClass.subClassOfTrait)+" +");
		}
		for (let i of this.directImpls) {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		}

		let dontOutputThese = new Set<string>();
		this.forEachSuperClass((c) => {
			c.methods.forEach((f) => {
				dontOutputThese.add(f.rustName);
			});
			c.properties.forEach((p) => {
				dontOutputThese.add("get_"+p.rustName);
				dontOutputThese.add("set_"+p.rustName);
			});
		});
		this.forEachSuperImpl((i) => {
			i.methods.forEach((f) => {
				dontOutputThese.add(f.rustName);
			});
			i.properties.forEach((p) => {
				dontOutputThese.add("get_"+p.rustName);
				dontOutputThese.add("set_"+p.rustName);
			});
		});

		/*this.forEachSuperClass((c) => {
			writeln("\t"+this.namespace.getRustPathTo(c.namespace, c.subClassOfTrait)+" +");
		});
		this.forEachSuperImpl((i) => {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		});*/
		writeln("{");
		this.getResolvedMethods().forEach((method) => {
			if (method.originalRustName !== undefined && !dontOutputThese.has(method.originalRustName)) {
				method.emit(indentAdder(writeln), FunctionKind.METHOD, true, this.namespace, context);
			}
		});
		this.properties.forEach((prop) => {
			if (!dontOutputThese.has("get_"+prop.rustName)) {
				writeln("\tfn get_"+prop.rustName+"(&self) -> "+prop.type.structName(this.namespace)+" {");
				writeln("\t\t"+prop.type.fromJsValue(this.namespace, "js!(return @{self}."+prop.jsName+";)"));
				writeln("\t}");
			}
			if (!dontOutputThese.has("set_"+prop.rustName)) {
				writeln("\tfn set_"+prop.rustName+"(&self, "+prop.rustName+": "+prop.type.inArgPosName(this.namespace)+") -> &Self {");
				writeln("\t\tjs!(@(no_return) @{self}."+prop.jsName+" = @{"+prop.rustName+"};);");
				writeln("\t\tself");
				writeln("\t}");
				writeln("");
			}
		});
		writeln("}");
		writeln("");
		writeln("impl<T: ::stdweb::JsSerialize> "+this.subClassOfTrait+" for Any<T> {}");
		writeln("");

		emitRefTypeTraits(this.rustName, writeln);

		this.forEachSuperClass((superClass) => {
			writeln("impl "+ this.namespace.getRustPathTo(superClass.namespace, superClass.subClassOfTrait) +" for "+this.rustName+" {}");
			writeln("impl<'a> "+ this.namespace.getRustPathTo(superClass.namespace, superClass.subClassOfTrait) +" for &'a "+this.rustName+" {}");
		});
		this.forEachSuperImpl((i) => {
			writeln("impl "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for "+this.rustName+" {}");
			writeln("impl<'a> "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for &'a "+this.rustName+" {}");
		});
		
		writeln("impl "+ this.subClassOfTrait +" for "+this.rustName+" {}");
		writeln("impl<'a> "+ this.subClassOfTrait +" for &'a "+this.rustName+" {}");
		writeln("");

		writeln("pub struct __"+this.rustName+"_Prototype(::stdweb::Reference);");
		writeln("");
		writeln("impl __"+this.rustName+"_Prototype {");
		writeln("\tpub fn __from_js_value(__value: ::stdweb::Value) -> Self {");
		writeln("\t\tSelf::__try_from_js_value(__value).unwrap_or_else(|err| panic!(err))");
		writeln("\t}");
		writeln("");
		writeln("\tpub fn __try_from_js_value(__value: ::stdweb::Value) -> Result<Self, &'static str> {");
		writeln("\t\tmatch __value {");
		writeln("\t\t\t::stdweb::Value::Reference(__js_ref) => Ok(__"+this.rustName+"_Prototype(__js_ref)),");
		writeln("\t\t\t_ => Err(\"Failed to initialize prototype of class "+this.rustName+" in "+this.namespace.toStringFull()+": the given stdweb::Value is not a reference.\")");
		writeln("\t\t}");
		writeln("\t}");
		writeln("");
		writeln("\tpub fn __from_js_ref(__js_ref: ::stdweb::Reference) -> Self {");
		writeln("\t\t__"+this.rustName+"_Prototype(__js_ref)");
		writeln("\t}");
		writeln("");
		this.getResolvedConstructors().forEach((constructor) => {
			constructor.emit(indentAdder(writeln), FunctionKind.CONSTRUCTOR, true, this.namespace, context);
		});
		this.getResolvedStaticFunctions().forEach((staticMethod) => {
			staticMethod.emit(indentAdder(writeln), FunctionKind.STATIC_METHOD, true, this.namespace, context);
		});
		writeln("}");
		writeln("");
		emitRefTypeTraits("__"+this.rustName+"_Prototype", writeln);

		/*let members = this.symbol.members;
		if (members !== undefined) {
			members.forEach((mem) => {
				console.log(" - "+mem.name);
			});
		}*/

		/*forEach(this.symbol.getDeclarations(), (decl) => {
			if (!ts.isClassDeclaration(decl)) {
				return;
			}
			let declName = decl.name;
			if (declName == undefined) {
				return;
			}
			let declNameType = context.checker.getTypeOfSymbolAtLocation(this.symbol, declName);
			let constructors = declNameType.getConstructSignatures();
			let numConstructorsWithNArgs : {[key:number]: number} = {};
			let numConstructorsWithNArgsEmitted : {[key:number]: number} = {};
			constructors.forEach((constructor) => {
				let n = constructor.parameters.length;
				if (numConstructorsWithNArgs.hasOwnProperty(n)) {
					numConstructorsWithNArgs[n] += 1;
				} else {
					numConstructorsWithNArgs[n] = 1;
				}
			});
			constructors.forEach((constructor) => {
				let rustifiedArgs = new Map<ts.Symbol, RustifiedType>();
				{
					let nArgs = constructor.parameters.length;
					let newFnName = "";
					if (numConstructorsWithNArgs[nArgs] > 1) {
						if (numConstructorsWithNArgsEmitted.hasOwnProperty(nArgs)) {
							numConstructorsWithNArgsEmitted[nArgs] += 1;
						} else {
							numConstructorsWithNArgsEmitted[nArgs] = 1;
						}
						newFnName = "__new_"+this.rustName + nArgs.toString() + numToAbc(numConstructorsWithNArgsEmitted[nArgs]);
					} else if (constructors.length > 1) {
						newFnName = "__new_"+this.rustName + nArgs.toString();
					} else {
						newFnName = "__new_"+this.rustName;
					}
					let line = "pub fn "+newFnName+"(";

					let firstParam = true;
					constructor.parameters.forEach((constructorParam) => {
						if (!firstParam) {
							line += ", ";
						}
						firstParam = false;

						let rustified = rustifyType(checker.getTypeOfSymbolAtLocation(constructorParam, constructorParam.valueDeclaration!), this.namespace, context);
						rustifiedArgs.set(constructorParam, rustified);
						
						//line += escapeRustName(constructorParam.name) + ": " + rustifyType(checker.getDeclaredTypeOfSymbol(constructorParam), context) + ", ";
						line += escapeRustName(constructorParam.name) + ": " + rustified.inArgPosName;
					});

					line += ") -> "+this.rustName+" {";

					writeln(line);
				}
				{
					let line = "\t"+this.rustName+"(__js_value_into_reference(js!(new "+checker.getFullyQualifiedName(this.symbol) + "(";
					let firstParam = true;
					constructor.parameters.forEach((constructorParam) => {
						if (!firstParam) {
							line += ", ";
						}
						firstParam = false;
						line += "@{"+escapeRustName(constructorParam.name)+"}";
					});
					line += "))))";
					writeln(line);
				}
				writeln("}");
			});
			if (constructors.length > 0) {
				writeln("");
			}

			/*if (symbol.members !== undefined) {
				symbol.members.forEach((memSym) => {
					let isProtected = false;
					if (memSym.declarations !== undefined) {
						let mods = memSym.declarations[0].modifiers;
						if (mods !== undefined) {
							isProtected = mods.some((v) => v.kind == ts.SyntaxKind.ProtectedKeyword);
						}
					}
					//console.log(" - member: "+memSym.getName()+". Protected: "+isProtected);
					if (memSym.declarations) {
						if (memSym.declarations.length > 0) {
							let decl = memSym.declarations[0];
							if (decl.modifiers) {
								//console.log(decl.modifiers.map((v,i,a) => syntaxKindToName(v.kind)));
							}
							//console.log(memSym.declarations!);
						}
					}
					let memType = checker.getTypeOfSymbolAtLocation(memSym, memSym.valueDeclaration!);
					let cons = memType.getCallSignatures();
					cons.forEach((v) => {
						v.parameters.forEach((p) => {
							let paramT = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration!);
							//console.log("    - param: "+p.name+": "+checker.typeToString(paramT));
						});
					});
				});
			}
		});*/
	}

	emitPrelude(writeln: (s:string) => void, context: Context) : void {
		writeln("pub use "+context.rootNameSpace.getRustPathTo(this.namespace, this.subClassOfTrait)+";");
	}
}

class Interface extends ClassOrInterface {
	constructor(public symbol: ts.Symbol, public type: ts.InterfaceType, public namespace: Namespace, public context: Context) {
		super(symbol, type, namespace, context);
		this.implementsTrait = escapeRustName("__Implements_"+symbol.name);

		this.rustifiedType = {
			fromJsValue: (ns: Namespace, s:string) => ns.getRustPathTo(this.namespace, this.rustName)+"(__js_value_into_reference("+s+", \""+this.rustName+"\"))",
			structName: (ns: Namespace) => ns.getRustPathTo(this.namespace, this.rustName),
			inArgPosName: (ns: Namespace) => "impl "+ns.getRustPathTo(this.namespace, this.implementsTrait),
			shortName: this.rustName,
			isNullable: false
		}
	}

	implementsTrait: string;
	rustifiedType: RustifiedType; 

	forEachSuperImpl(cb: (i:Interface) => void) {
		let visited = new Set<Interface>();
		function rec(node:ClassOrInterface) {
			for (let i of node.directImpls) {
				if (!visited.has(i)) {
					visited.add(i);
					rec(i);
					cb(i);
				}
			}
		}
		rec(this);
	}

	emit(writeln: (s:string) => void, context: Context) : void {
		let checker = context.checker;
		this.emitDocs(writeln, context);
		writeln("pub struct "+this.rustName+"(pub ::stdweb::Reference);");
		writeln("");
		writeln("pub trait "+this.implementsTrait+":");
		writeln("\t"+INTERFACE_BASE_TRAITS+" +");
		for (let i of this.directImpls) {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		}

		let dontOutputThese = new Set<string>();
		let allProps : Variable[] = [];
		this.forEachSuperImpl((i) => {
			i.methods.forEach((f) => {
				dontOutputThese.add(f.rustName);
			});
			i.properties.forEach((p) => {
				if (!dontOutputThese.has("get_"+p.rustName) || !dontOutputThese.has("set_"+p.rustName)) {
					allProps.push(p);
				}
				dontOutputThese.add("get_"+p.rustName);
				dontOutputThese.add("set_"+p.rustName);
			});
		});
		this.properties.forEach((p) => {
			if (!dontOutputThese.has("get_"+p.rustName) || !dontOutputThese.has("set_"+p.rustName)) {
				allProps.push(p);
			}
		});

		/*this.forEachSuperImpl((i) => {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		});*/
		writeln("{");
		this.getResolvedMethods().forEach((method) => {
			if (method.originalRustName !== undefined && !dontOutputThese.has(method.originalRustName)) {
				method.emit(indentAdder(writeln), FunctionKind.METHOD, true, this.namespace, context);
			}
		})
		this.properties.forEach((prop) => {
			if (!dontOutputThese.has("get_"+prop.rustName)) {
				writeln("\tfn get_"+prop.rustName+"(&self) -> "+prop.type.structName(this.namespace)+" {");
				writeln("\t\t"+prop.type.fromJsValue(this.namespace, "js!(return @{self}."+prop.jsName+";)"));
				writeln("\t}");
			}
			if (!dontOutputThese.has("set_"+prop.rustName)) {
				writeln("\tfn set_"+prop.rustName+"(&self, "+prop.rustName+": "+prop.type.inArgPosName(this.namespace)+") -> &Self {");
				writeln("\t\tjs!(@(no_return) @{self}."+prop.jsName+" = @{"+prop.rustName+"};);");
				writeln("\t\tself");
				writeln("\t}");
			}
		});
		writeln("}");
		writeln("");
		this.forEachSuperImpl((i) => {
			writeln("impl "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for "+this.rustName+" {}");
			writeln("impl<'a> "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for &'a "+this.rustName+" {}");
		});
		writeln("impl "+this.implementsTrait+" for "+this.rustName+" {}");
		writeln("impl<'a> "+this.implementsTrait+" for &'a "+this.rustName+" {}");
		writeln("impl<T: ::stdweb::JsSerialize> "+this.implementsTrait+" for Any<T> {}");
		writeln("");
		
		emitRefTypeTraits(this.rustName, writeln);
		
		writeln("pub struct __"+this.rustName+"_Prototype {");
		writeln("}");
		writeln("");
		writeln("impl __"+this.rustName+"_Prototype {");
		let defLine = "\tpub fn new(&self";
		allProps.forEach((prop) => {
			if (!prop.isOptional) {
				defLine += ", "+prop.rustName+": "+prop.type.inArgPosName(this.namespace);
			}
		});
		defLine += ") -> "+this.rustName+" {";
		writeln(defLine);
		let implLine = "\t\t"+this.rustName+"(__js_value_into_reference(js!(return {";
		let firstArg = true;
		allProps.forEach((prop) => {
			if (!prop.isOptional) {
				if (!firstArg) {
					implLine += ", ";
				}
				firstArg = false;
				implLine += prop.jsName+": @{"+prop.rustName+"}";
			}
		});
		implLine += "};), \"object implementing "+this.rustName+"\"))";
		writeln(implLine);
		writeln("\t}");
		writeln("}");
		writeln("");
	}

	emitPrelude(writeln: (s:string) => void, context: Context) : void {
		writeln("pub use "+context.rootNameSpace.getRustPathTo(this.namespace, this.implementsTrait)+";");
	}
}

class Variable {
	constructor(public jsName: string, public jsType: string, public rustName: string, public type: RustifiedType, public isOptional: boolean) {}

	isSameAs(other: Variable, context: Context) : boolean {
		return this.rustName == other.rustName && rustifiedTypesAreSame(this.type, other.type, context);
	}
}

class Signature {
	constructor(public args: Variable[], public returnType: RustifiedType, public returnJsType: string) {
		let structName = this.getRustTypeName(false);
		let traitName = this.getRustTypeName(true);
		this.rustifiedType = {
			fromJsValue: (ns: Namespace, s:string) => structName+"(__js_value_into_reference("+s+", \""+structName+"\"))",
			structName: (ns: Namespace) => structName,
			inArgPosName: (ns: Namespace) => "impl "+traitName,
			shortName: "Fn"+this.args.length,
			isNullable: false
		};
	}

	rustifiedType: RustifiedType;

	isSameAs(other: Signature, context: Context) : boolean {
		if (this.args.length != other.args.length) {
			return false;
		}
		for (let i = 0; i < this.args.length; i++) {
			if (!this.args[i].isSameAs(other.args[i], context)) {
				return false;
			}
		}
		if (!rustifiedTypesAreSame(this.returnType, other.returnType, context)) {
			return false;
		}
		return true;
	}

	getRustTypeName(trait: boolean) : string {
		let result = (trait ? "JsCallable" : "JsFn");
		if (this.args.length > 0) {
			result += "__";
			let isFirstParam = true;
			this.args.forEach((arg) => {
				if (!isFirstParam) {
					result += "_";
				}
				isFirstParam = false;
				result += arg.type.shortName;
			});
		}
		result += "__"+this.returnType.shortName;
		return result;
	}
}

function emitDocs(writeln: (s:string) => void, docs: ts.SymbolDisplayPart[]) {
	if (docs.length > 0) {
		let str = ts.displayPartsToString(docs);
		let lines = str.split("\n");
		forEach(lines, (line) => {
			writeln("/// "+line);
		});
	}
}

enum FunctionKind {
	METHOD,
	CONSTRUCTOR,
	FREE_FUNCTION,
	NAMESPACED_FUNCTION,
	STATIC_METHOD
}

class Function {
	/// originalName is only defined if this is renamed for type collision purposes
	constructor(public rustName: string, public originalRustName: string | undefined, public signature: Signature, public docs: ts.SymbolDisplayPart[]) {}

	isSameAs(other: Function, context: Context) : boolean {
		if (this.rustName != other.rustName) {
			return false;
		}
		if (!this.signature.isSameAs(other.signature, context)) {
			return false;
		}
		return true;
	}
	
	emit(writeln: (s:string) => void, kind: FunctionKind, withImplementation: boolean, namespace: Namespace, context: Context) {
		let shouldPrintDocs = (this.docs.length > 0 || this.signature.args.length > 0 || !rustifiedTypesAreSame(this.signature.returnType, UnitRustifiedType, context));
		if (shouldPrintDocs) {
			writeln("/**");
		}
		let shouldPrintParamsAndReturn = shouldPrintDocs;
		if (this.docs.length > 0) {
			let str = ts.displayPartsToString(this.docs);
			let containsParamDocs = (str.indexOf("@param") >= 0 || str.indexOf("@returns") >= 0);
			let lines = str.split("\n");
			for (let line of lines) {
				writeln(" * "+line);
			}
			if (!containsParamDocs) {
				writeln(" *");
				shouldPrintParamsAndReturn = true;
			}
		}
		if (shouldPrintParamsAndReturn) {
			if (this.signature.args.length > 0) {
				writeln(" * Parameters:");
			}
			for (let arg of this.signature.args) {
				writeln(" *  - "+arg.jsName+(arg.isOptional ? "?":"")+" : "+arg.jsType);
			}
			if (!rustifiedTypesAreSame(this.signature.returnType, UnitRustifiedType, context)) {
				writeln(" * Returns: "+this.signature.returnJsType);
			}
			writeln(" */");
		}
		{
			let line = "";
			if (kind != FunctionKind.METHOD) {
				line += "pub ";
			}
			line += "fn "+this.rustName+"(";
			let isFirstParam = true;
			if (kind != FunctionKind.FREE_FUNCTION) {
				line += "&self";
				isFirstParam = false;
			}
			this.signature.args.forEach((arg) => {
				if (!isFirstParam) {
					line += ", ";
				}
				isFirstParam = false;
				line += arg.rustName + ": " + arg.type.inArgPosName(namespace);
			});
			line += ") -> "+this.signature.returnType.structName(namespace);
			if (withImplementation) {
				line += " {";
			} else {
				line += ";"
			}
			writeln(line);
		}
		if (withImplementation) {
			let line = "\t";
			let jsLine = "js!(";
			if (rustifiedTypesAreSame(this.signature.returnType, UnitRustifiedType, context)) {
				jsLine += "@(no_return) ";
			} else {
				jsLine += "return ";
			}
			if (kind == FunctionKind.METHOD || kind == FunctionKind.NAMESPACED_FUNCTION || kind == FunctionKind.STATIC_METHOD) {
				jsLine += "@{self}."+this.rustName+"(";
			} else if (kind == FunctionKind.CONSTRUCTOR) {
				jsLine += "new @{self}(";
			} else if (kind == FunctionKind.FREE_FUNCTION) {
				jsLine += this.rustName+"(";
			}
			let isFirstParam = true;
			this.signature.args.forEach((arg) => {
				if (!isFirstParam) {
					jsLine += ", ";
				}
				isFirstParam = false;
				jsLine += "@{"+arg.rustName+"}";
			});
			jsLine += ");)";
			line += this.signature.returnType.fromJsValue(namespace, jsLine);
			writeln(line);
			writeln("}");
			writeln("");
		}
	}
}

class Namespace {
	constructor(public parent: Namespace | undefined, public jsName: string) {
		if (this.jsName === "" && this.parent !== undefined) {
			console.error("Namespace without name found that isn't the root namespace!");
			console.error("Parent: "+this.parent.toStringFull());
			throw "terminating...";
		}
		this.rustName = escapeRustName(this.jsName);
		this.subNamespaces = {};
		this.classes = {};
		this.interfaces = {};
		this.functions = [];
		this.resolvedFunctions = [];
	}

	rustName: string;
	subNamespaces: {[name:string]: Namespace};
	classes: {[name:string]: Class};
	interfaces: {[name:string]: Interface};
	private functions: Function[];
	private resolvedFunctions: Function[];

	toStringFull() : string {
		function rec(ns:Namespace) : string {
			if (ns.parent === undefined) {
				return ns.jsName;
			} else {
				let r = rec(ns.parent);
				if (r == "") {
					return ns.jsName;
				} else {
					return r + "::" + ns.jsName;
				}
			}
		}

		let r = rec(this);
		if (r == "") {
			return "the root namespace";
		} else {
			return "namespace "+r;
		}
	}

	addFunction(f:Function, context: Context) {
		for (let existingF of this.functions) {
			if (f.isSameAs(existingF, context)) {
				return;
			}
		}
		this.functions.push(f);
	}

	getResolvedFunctions() : Function[] {
		if (this.resolvedFunctions.length == this.functions.length) {
			return this.resolvedFunctions;
		} else {
			let result : Function[] = [];
			forEachFunctionWithUniqueNames(this.functions, (f, uniqueName) => {
				result.push(new Function(uniqueName, f.rustName, f.signature, f.docs));
			});
			this.resolvedFunctions = result;
			return result;
		}
	}

	private getOrCreateItemOfType<T>(name: string, nameMap: {[name:string]: T}, creator: () => T) : T {
		if (nameMap.hasOwnProperty(name)) {
			return nameMap[name];
		} else {
			let newItem = creator();
			nameMap[name] = newItem;
			return newItem;
		}
	}

	getOrCreateSubNamespace(name: string) : Namespace {
		return this.getOrCreateItemOfType(name, this.subNamespaces, () => new Namespace(this, name));
	}

	getOrCreateClass(symbol: ts.Symbol, type: ts.InterfaceType, context: Context) : Class {
		return this.getOrCreateItemOfType(symbol.name, this.classes, () => new Class(symbol, type, this, context));
	}

	getOrCreateInterface(symbol: ts.Symbol, type: ts.InterfaceType, context: Context) : Interface {
		return this.getOrCreateItemOfType(symbol.name, this.interfaces, () => new Interface(symbol, type, this, context));
	}

	getRustPathTo(other: Namespace, itemName: string) : string {
		let fromHere = new Map<Namespace, string>();
		let fqn : string | undefined = undefined;
		function rec(node: Namespace, pathSoFar: string) {
			fromHere.set(node, pathSoFar);
			if (node.parent !== undefined) {
				if (node.jsName !== "") {
					if (pathSoFar != "") {
						rec(node.parent, node.jsName + "::" + pathSoFar);
					} else {
						rec(node.parent, node.jsName);
					}
				} else {
					fromHere.set(node.parent, pathSoFar);
				}
			} else {
				fqn = pathSoFar;
			}
		}
		rec(other, "");

		let cur : Namespace | undefined = this;
		while (cur !== undefined) {
			if (fromHere.has(cur)) {
				let result = fromHere.get(cur)!;
				if (result.length == 0) {
					return itemName;
				} else {
					return result + "::" + itemName;
				}
			} else {
				cur = cur.parent;
			}
		}

		if (fqn !== undefined) {
			if (fqn!.length == 0) {
				return itemName;
			} else {
				return fqn + "::" + itemName;
			}
		} else {
			return itemName;
		}
	}

	emit(writeln: (s:string) => void, context:Context) {
		let checker = context.checker;
		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			writeln("pub mod "+subNS.rustName+" {");
			writeln("\tuse super::*;");
			writeln("");
			subNS.emit(indentAdder(writeln), context);
			writeln("}");
			writeln("");
		});

		forEachKeyValueInObject(this.classes, (className, theClass) => {
			theClass.emit(writeln, context);
		});

		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			theInterface.emit(writeln, context);
		});

		let eagerNamespaceRustName = "__EagerNamespace_"+this.rustName;
		if (this.parent == undefined) {
			eagerNamespaceRustName = "__EagerGlobals";
		}

		writeln("pub struct "+eagerNamespaceRustName+" {");
		writeln("\t__js_ref: ::stdweb::Reference,");
		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			writeln("\tpub "+subNS.rustName+": "+subNS.rustName+"::__EagerNamespace_"+subNS.rustName+",");
		});
		forEachKeyValueInObject(this.classes, (className, theClass) => {
			writeln("\tpub "+theClass.rustName+": __"+theClass.rustName+"_Prototype,");
		});
		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			writeln("\tpub "+theInterface.rustName+": __"+theInterface.rustName+"_Prototype,");
		});
		writeln("}");
		writeln("");
		writeln("impl "+eagerNamespaceRustName+" {");
		writeln("\t/// Using this function is not recommended because it iterates and stores a reference to");
		writeln("\t/// every class prototype in this namespace and all sub-namespaces. This may be slow.");
		writeln("\t/// It also fails if there is ANY discrepancy between the TypeScript definitions and the actual object.");
		writeln("\tpub fn __from_js_value(__value: ::stdweb::Value) -> Self {");
		writeln("\t\tSelf::__try_from_js_value(__value).unwrap_or_else(|err| panic!(err))");
		writeln("\t}");
		writeln("");
		writeln("\t/// Using this function is not recommended because it iterates and stores a reference to");
		writeln("\t/// every class prototype in this namespace and all sub-namespaces. This may be slow.");
		writeln("\t/// It also fails if there is ANY discrepancy between the TypeScript definitions and the actual object.");
		writeln("\tpub fn __try_from_js_value(__value: ::stdweb::Value) -> Result<Self, &'static str> {");
		writeln("\t\tmatch __value {");
		writeln("\t\t\t::stdweb::Value::Reference(ref __js_ref) => "+eagerNamespaceRustName+"::__try_from_js_ref(__js_ref),");
		writeln("\t\t\t_ => Err(\"Failed to initialize "+this.toStringFull()+": the given stdweb::Value is not a reference.\")");
		writeln("\t\t}");
		writeln("\t}");
		writeln("");
		writeln("\t/// Using this function is not recommended because it iterates and stores a reference to");
		writeln("\t/// every class prototype in this namespace and all sub-namespaces. This may be slow.");
		writeln("\t/// It also fails if there is ANY discrepancy between the TypeScript definitions and the actual object.");
		writeln("\tpub fn __from_js_ref(__js_ref: &::stdweb::Reference) -> Self {");
		writeln("\t\tSelf::__try_from_js_ref(__js_ref).unwrap_or_else(|err| panic!(err))");
		writeln("\t}");
		writeln("");
		writeln("\t/// Using this function is not recommended because it iterates and stores a reference to");
		writeln("\t/// every class prototype in this namespace and all sub-namespaces. This may be slow.");
		writeln("\t/// It also fails if there is ANY discrepancy between the TypeScript definitions and the actual object.");
		writeln("\tpub fn __try_from_js_ref(__js_ref: &::stdweb::Reference) -> Result<Self, &'static str> {");
		writeln("\t\tOk(Self {");
		writeln("\t\t\t__js_ref: __js_ref.clone(),");
		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			writeln("\t\t\t"+subNS.rustName+": "+subNS.rustName+"::__EagerNamespace_"+subNS.rustName+"::__try_from_js_value(js!(return @{__js_ref}."+subNS.jsName+";))?,");
		});
		forEachKeyValueInObject(this.classes, (className, theClass) => {
			writeln("\t\t\t"+theClass.rustName+": __"+theClass.rustName+"_Prototype::__try_from_js_value(js!(return @{__js_ref}."+theClass.symbol.name+";))?,");
		});
		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			writeln("\t\t\t"+theInterface.rustName+": __"+theInterface.rustName+"_Prototype {},");
		});
		writeln("\t\t})");
		writeln("\t}");
		writeln("}");
		writeln("");

		emitImplJsSerializeForType(eagerNamespaceRustName, "self.__js_ref", writeln);

		let lazyNamespaceRustName = "__LazyNamespace_"+this.rustName;
		if (this.parent == undefined) {
			lazyNamespaceRustName = "__LazyGlobals";
		}

		writeln("pub struct "+lazyNamespaceRustName+"(::stdweb::Reference);");
		writeln("");
		writeln("impl "+lazyNamespaceRustName+" {");
		writeln("\tpub fn __from_js_value(__value: ::stdweb::Value) -> Self {");
		writeln("\t\tSelf::__try_from_js_value(__value).unwrap_or_else(|err| panic!(err))");
		writeln("\t}");
		writeln("\t");
		writeln("\tpub fn __try_from_js_value(__value: ::stdweb::Value) -> Result<Self, &'static str> {");
		writeln("\t\tmatch __value {");
		writeln("\t\t\t::stdweb::Value::Reference(__js_ref) => Ok("+lazyNamespaceRustName+"( __js_ref )),");
		writeln("\t\t\t_ => Err(\"Failed to initialize "+this.toStringFull()+": the given stdweb::Value is not a reference.\")");
		writeln("\t\t}");
		writeln("\t}");
		writeln("");
		writeln("\tpub fn __from_js_ref(__js_ref: ::stdweb::Reference) -> Self {");
		writeln("\t\t"+lazyNamespaceRustName+"(__js_ref)");
		writeln("\t}");
		writeln("");
		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			writeln("\tpub fn "+subNS.rustName+"(&self) -> "+subNS.rustName+"::__LazyNamespace_"+subNS.rustName+" {");
			writeln("\t\t"+subNS.rustName+"::__LazyNamespace_"+subNS.rustName+"::__from_js_value(js!(return @{self}."+subNS.jsName+";))");
			writeln("\t}");
			writeln("");
		});
		forEachKeyValueInObject(this.classes, (className, theClass) => {
			writeln("\tpub fn "+theClass.rustName+"(&self) -> __"+theClass.rustName+"_Prototype {");
			writeln("\t\t__"+theClass.rustName+"_Prototype::__from_js_value(js!(return @{self}."+theClass.symbol.name+";))");
			writeln("\t}");
			writeln("");
		});
		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			writeln("\tpub fn "+theInterface.rustName+"(&self) -> __"+theInterface.rustName+"_Prototype {");
			writeln("\t\t__"+theInterface.rustName+"_Prototype {}");
			writeln("\t}");
			writeln("");
		});
		if (this.parent != undefined) {
			this.getResolvedFunctions().forEach((f) => {
				f.emit(indentAdder(writeln), FunctionKind.NAMESPACED_FUNCTION, true, this, context);
			});
		}
		writeln("}");
		writeln("");
		
		//if (this.parent != undefined) {
		emitRefTypeTraits(lazyNamespaceRustName, writeln);
		//}

		if (this.parent == undefined) {
			this.getResolvedFunctions().forEach((f) => {
				f.emit(writeln, FunctionKind.FREE_FUNCTION, true, this, context);
			});
		}

		/*let hasAtLeastOneClass = false;
		forEachKeyValueInObject(this.classes, (className, theClass) => {
			hasAtLeastOneClass = true;
		});
		if (hasAtLeastOneClass) {
			writeln("pub mod class {");
			writeln("\tuse super::*;");
			writeln("");
			forEachKeyValueInObject(this.classes, (className, theClass) => {
				theClass.emitStatics(indentAdder(writeln), context);
			});
			writeln("}");
			writeln("");
		}

		let hasAtLeastOneInterface = false;
		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			hasAtLeastOneInterface = true;
		});
		if (hasAtLeastOneInterface) {
			writeln("pub mod interface {");
			writeln("\tuse super::*;");
			writeln("");
			forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
				theInterface.emitStatics(indentAdder(writeln), context);
			});
			writeln("}");
			writeln("");
		}*/
	}
	
	emitPrelude(writeln: (s:string) => void, context:Context) {
		let checker = context.checker;
		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			subNS.emitPrelude(writeln, context);
		});

		forEachKeyValueInObject(this.classes, (className, theClass) => {
			theClass.emitPrelude(writeln, context);
		});

		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			theInterface.emitPrelude(writeln, context);
		});
	}

	emitStatics(writeln: (s:string) => void, context: Context) {
		/*writeln("pub struct EagerNamespace {");
		writeln("\t__js_ref: ::stdweb::Reference,");
		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			writeln("\tpub "+subNS.rustName+": "+subNS.rustName+"::EagerNamespace,");
		});
		forEachKeyValueInObject(this.classes, (className, theClass) => {
			writeln("\tpub "+theClass.rustName+": class::"+theClass.rustName+",");
		});
		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			writeln("\tpub "+theInterface.rustName+": interface::"+theInterface.rustName+",");
		});
		writeln("}");
		writeln("");
		writeln("impl EagerNamespace {");
		writeln("\tpub fn __init_from_js_value(__value: ::stdweb::Value) -> Result<Self, &'static str> {");
		writeln("\t\tmatch __value {");
		writeln("\t\t\t::stdweb::Value::Reference(ref __js_ref) => Ok(Self {");
		writeln("\t\t\t\t__js_ref: __js_ref.clone(),");
		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			writeln("\t\t\t\t"+subNS.rustName+": "+subNS.rustName+"::EagerNamespace::__init_from_js_value(js!(@{__js_ref}."+subNS.jsName+"))?,");
		});
		forEachKeyValueInObject(this.classes, (className, theClass) => {
			writeln("\t\t\t\t"+theClass.rustName+": class::"+theClass.rustName+"::__init_from_js_value(js!(@{__js_ref}."+theClass.symbol.name+"))?,");
		});
		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			writeln("\t\t\t\t"+theInterface.rustName+": interface::"+theInterface.rustName+"::__init_from_js_value(js!(@{__js_ref}."+theInterface.symbol.name+"))?,");
		});
		writeln("\t\t\t}),");
		writeln("\t\t\t_ => Err(\"Failed to initialize "+this.toStringFull()+": the given stdweb::Value is not a reference.\")");
		writeln("\t\t}");
		writeln("\t}");
		writeln("}");
		writeln("");

		forEachKeyValueInObject(this.subNamespaces, (subNsName, subNS) => {
			writeln("pub mod "+subNS.rustName+" {");
			writeln("\tuse super::*;");
			writeln("");
			subNS.emitStatics(indentAdder(writeln), context);
			writeln("}");
			writeln("");
		});

		let hasAtLeastOneClass = false;
		forEachKeyValueInObject(this.classes, (className, theClass) => {
			hasAtLeastOneClass = true;
		});
		if (hasAtLeastOneClass) {
			writeln("pub mod class {");
			writeln("\tuse super::*;");
			writeln("");
			forEachKeyValueInObject(this.classes, (className, theClass) => {
				theClass.emitStatics(indentAdder(writeln), context);
			});
			writeln("}");
			writeln("");
		}

		let hasAtLeastOneInterface = false;
		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			hasAtLeastOneInterface = true;
		});
		if (hasAtLeastOneInterface) {
			writeln("pub mod interface {");
			writeln("\tuse super::*;");
			writeln("");
			forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
				theInterface.emitStatics(indentAdder(writeln), context);
			});
			writeln("}");
			writeln("");
		}*/
	}
}

const CLASS_BASE_TRAITS = "::stdweb::private::JsSerialize";// + ::stdweb::private::JsSerializeOwned";
const INTERFACE_BASE_TRAITS = "::stdweb::private::JsSerialize";// + ::stdweb::private::JsSerializeOwned";

const rustKeywords = {
	"_": true,
	"as": true,
	"box": true,
	"break": true,
	"const": true,
	"continue": true,
	"crate": true,
	"else": true,
	"enum": true,
	"extern": true,
	"false": true,
	"fn": true,
	"for": true,
	"if": true,
	"impl": true,
	"in": true,
	"let": true,
	"loop": true,
	"match": true,
	"mod": true,
	"move": true,
	"mut": true,
	"pub": true,
	"ref": true,
	"return": true,
	"self": true,
	"Self": true,
	"static": true,
	"struct": true,
	"super": true,
	"trait": true,
	"true": true,
	"type": true,
	"unsafe": true,
	"use": true,
	"where": true,
	"while": true,
	"abstract": true,
	"alignof": true,
	"become": true,
	"do": true,
	"final": true,
	"macro": true,
	"offsetof": true,
	"override": true,
	"priv": true,
	"pure": true,
	"sizeof": true,
	"typeof": true,
	"unsized": true,
	"virtual": true,
	"yield": true,
	"async": true,
	"auto": true,
	"catch": true,
	"default": true,
	"dyn": true,
	"union": true
};

function escapeRustName(name:string) : string {
	while (
		name.length > 2 && (
			(name.charCodeAt(0) == 34 && name.charCodeAt(name.length-1) == 34) ||
			(name.charCodeAt(0) == 39 && name.charCodeAt(name.length-1) == 39)
		)
	) {
		name = name.substr(1, name.length-2);
	}
	if (rustKeywords.hasOwnProperty(name)) {
		name = name+"__";
	}
	let newName = "";
	for (let i = 0; i < name.length; i++) {
		let c = name.charCodeAt(i);
		if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57 && i > 0) || c == 95) {
			newName += String.fromCharCode(c);
		} else if (c == 45 || c == 46) {
			newName += "_";
		} else {
			newName += "_Ux"+c.toString(16);
		}
	}
	return newName;
}

function getSubClassOfTraitName(className:string) : string {
	return escapeRustName("__SubClassOf_"+className);
}

function rustifyFullyQualifiedName(fullyQualifiedName: string) : string {
	return fullyQualifiedName.split('.').map(escapeRustName).join("::");
}

function rustifyAndMapToTraitFullyQualifiedName(fullyQualifiedName: string) : string {
	let arr = fullyQualifiedName.split('.');
	if (arr.length == 0) {
		console.error("Fully qualified name \""+fullyQualifiedName+"\" is not valid!");
		throw "exiting...";
	}
	arr[arr.length-1] = getSubClassOfTraitName(arr[arr.length-1]);
	return arr.map(escapeRustName).join("::");
}

let typeToStdwebTypeMap : {[key:string]: RustifiedType} = {};
{
	function add(key:string, val:string) {
		typeToStdwebTypeMap[key] = {
			fromJsValue: (ns: Namespace, s:string) => "unsafe {<::stdweb::web::"+val+" as ::stdweb::ReferenceType>::from_reference_unchecked(__js_value_into_reference("+s+", \"::stdweb::web::"+val+"\"))}",
			structName: (ns: Namespace) => "::stdweb::web::"+val,
			inArgPosName: (ns: Namespace) => "::stdweb::web::"+val,
			shortName: key,
			isNullable: false
		};
	}

	add("HTMLCanvasElement", "html_element::CanvasElement");
	// TODO: add the rest
}
typeToStdwebTypeMap["Function"] = {
	fromJsValue: (ns: Namespace, s:string) => "__UntypedJsFn(__js_value_into_reference("+s+", \"function\"))",
	structName: (ns: Namespace) => "__UntypedJsFn",
	inArgPosName: (ns: Namespace) => "impl __JsCallable",
	shortName: "Fn",
	isNullable: false
};

interface RustifiedType {
	fromJsValue: (ns: Namespace, jsCode: string) => string,
	structName: (ns: Namespace) => string,
	inArgPosName: (ns: Namespace) => string,
	shortName: string,
	isNullable: boolean,
}

const AnyRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "Any("+s+")",
	structName: (ns: Namespace) => "Any<::stdweb::Value>",
	inArgPosName: (ns: Namespace) => "impl ::stdweb::JsSerialize",
	shortName: "Any",
	isNullable: true,
}

const UnknownRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => s,
	structName: (ns: Namespace) => "::stdweb::Value",
	inArgPosName: (ns: Namespace) => "impl ::stdweb::JsSerialize",
	shortName: "Unknown",
	isNullable: true,
}

const NumberRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_number("+s+")",
	structName: (ns: Namespace) => "f64",
	inArgPosName: (ns: Namespace) => "f64",
	shortName: "Number",
	isNullable: false,
}

const StringRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_string("+s+")",
	structName: (ns: Namespace) => "String",
	inArgPosName: (ns: Namespace) => "impl AsRef<str> + stdweb::JsSerialize",
	shortName: "String",
	isNullable: false,
}

const BoolRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_bool("+s+")",
	structName: (ns: Namespace) => "bool",
	inArgPosName: (ns: Namespace) => "bool",
	shortName: "Bool",
	isNullable: false,
}

const SymbolRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_symbol("+s+")",
	structName: (ns: Namespace) => "::stdweb::Symbol",
	inArgPosName: (ns: Namespace) => "::stdweb::Symbol",
	shortName: "Symbol",
	isNullable: false,
}

const UndefinedRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_undefined("+s+")",
	structName: (ns: Namespace) => "::stdweb::Undefined",
	inArgPosName: (ns: Namespace) => "::stdweb::Undefined",
	shortName: "Undefined",
	isNullable: true,
}

const NullRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_null("+s+")",
	structName: (ns: Namespace) => "::stdweb::Null",
	inArgPosName: (ns: Namespace) => "::stdweb::Null",
	shortName: "Null",
	isNullable: false, // it's handled as a special case in makeRustifiedTypeOptional()
}

const UnitRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => s+";",
	structName: (ns: Namespace) => "()",
	inArgPosName: (ns: Namespace) => "()",
	shortName: "Void",
	isNullable: false, // it's handled as a special case in makeRustifiedTypeOptional()
}


function rustifyTypeUsingOnlyFlags(type:ts.Type) : RustifiedType {
	let f = type.flags;
	if (f & ts.TypeFlags.Any) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.String) {
		return StringRustifiedType;
	} else if (f & ts.TypeFlags.Number) {
		return NumberRustifiedType;
	} else if (f & ts.TypeFlags.Boolean) {
		return BoolRustifiedType;
	} else if (f & ts.TypeFlags.Enum) {
		return NumberRustifiedType;
	} else if (f & ts.TypeFlags.StringLiteral) {
		return StringRustifiedType;
	} else if (f & ts.TypeFlags.NumberLiteral) {
		return NumberRustifiedType;
	} else if (f & ts.TypeFlags.BooleanLiteral) {
		return BoolRustifiedType;
	} else if (f & ts.TypeFlags.EnumLiteral) {
		return NumberRustifiedType;
	} else if (f & ts.TypeFlags.ESSymbol) {
		return SymbolRustifiedType;
	} else if (f & ts.TypeFlags.UniqueESSymbol) {
		return SymbolRustifiedType;
	} else if (f & ts.TypeFlags.Void) {
		return UnitRustifiedType;
	} else if (f & ts.TypeFlags.Undefined) {
		return UndefinedRustifiedType;
	} else if (f & ts.TypeFlags.Null) {
		return NullRustifiedType;
	} else if (f & ts.TypeFlags.Never) {
		return UnitRustifiedType;
	} else if (f & ts.TypeFlags.TypeParameter) {
		return UnknownRustifiedType;
	} else if (f & ts.TypeFlags.Object) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.Union) {
		return UnknownRustifiedType;
	} else if (f & ts.TypeFlags.Intersection) {
		return UnknownRustifiedType;
	} else if (f & ts.TypeFlags.Index) {
		return UnknownRustifiedType;
	} else if (f & ts.TypeFlags.IndexedAccess) {
		return UnknownRustifiedType;
	} else if (f & ts.TypeFlags.Conditional) {
		return UnknownRustifiedType;
	} else if (f & ts.TypeFlags.Substitution) {
		return UnknownRustifiedType;
	} else if (f & ts.TypeFlags.NonPrimitive) {
		return UnknownRustifiedType;
	} else {
		return UnknownRustifiedType;
	}
}

function makeRustifiedTypeOptional(type: RustifiedType, context:Context) : RustifiedType {
	if (type.isNullable) {
		return type;
	} else if (rustifiedTypesAreSame(type, UnitRustifiedType, context)) {
		// does an optional void even exist?
		return UnitRustifiedType;
	} else if (rustifiedTypesAreSame(type, NullRustifiedType, context)) {
		// so this is the type "undefined | null". I guess null should map to Some(Null) in this case but I seriously doubt if anyone uses types like this.
		return {
			fromJsValue: (ns: Namespace, s:string) => "match "+s+" { ::stdweb::Value::Undefined => None, ___other => Some("+type.fromJsValue(ns, "___other")+") }",
			structName: (ns: Namespace) => "Option<"+type.structName(ns)+">",
			inArgPosName: (ns: Namespace) => "Option<"+type.inArgPosName(ns)+">",
			shortName: "Optional"+type.shortName,
			isNullable: true
		};
	}
	// in all other cases I'll let null map to None.
	return {
		fromJsValue: (ns: Namespace, s:string) => "match "+s+" { ::stdweb::Value::Undefined | ::stdweb::Value::Null => None, ___other => Some("+type.fromJsValue(ns, "___other")+") }",
		structName: (ns: Namespace) => "Option<"+type.structName(ns)+">",
		inArgPosName: (ns: Namespace) => "Option<"+type.inArgPosName(ns)+">",
		shortName: "Optional"+type.shortName,
		isNullable: true
	};
}

let collectedTypes = new Map<ts.Type, RustifiedType>();

function collectType(type:ts.Type, context:Context) : RustifiedType {
	let cached = collectedTypes.get(type);
	if (cached !== undefined) {
		return cached;
	} else {
		let result = impl();
		collectedTypes.set(type, result);
		return result;
	}

	function impl() : RustifiedType {
		if (type.isUnion()) {
			let types = type.types.map((t) => collectType(t, context));
			let type0str = types[0].structName(context.rootNameSpace);
			let allMatch = true;
			for (let i = 1; i < types.length; i++) {
				if (type0str != types[i].structName(context.rootNameSpace)) {
					allMatch = false;
					break;
				}
			}
			if (allMatch) {
				return types[0];
			} else {
				return UnknownRustifiedType;
			}
		}

		let callSigs = type.getCallSignatures();
		if (callSigs.length == 1) {
			let sig = collectSignature(callSigs[0], context);
			return collectClosure(sig, context);
		}

		let symbol = undefined;
		if (type.aliasSymbol !== undefined) {
			symbol = type.aliasSymbol;
		} else if (type.symbol !== undefined) {
			symbol = type.symbol;
		}
		if (symbol === undefined) {
			return rustifyTypeUsingOnlyFlags(type);
		} else {
			return collectSymbolAndType(symbol, type, context);
		}
	}
}

function collectSymbolAndType(symbol: ts.Symbol, type: ts.Type, context:Context) : RustifiedType {
	function impl() : RustifiedType {
		let callSigs = type.getCallSignatures();
		if (callSigs.length == 1) {
			let sig = collectSignature(callSigs[0], context);
			return collectClosure(sig, context);
		}

		let shouldOutputType = false;
		let decls = symbol.getDeclarations();
		if (decls !== undefined) {
			for (const decl of decls) {
				let fileName = decl.getSourceFile().fileName;
				if (context.sourceFiles.indexOf(fileName) >= 0) {
					shouldOutputType = true;
				}
			}
		}

		if (shouldOutputType) {
			if (type.isClass()) {
				return collectClass(symbol, type, context).rustifiedType;
			} else if (type.isClassOrInterface()) {
				return collectInterface(symbol, type, context).rustifiedType;
			} else if (symbol.flags & ts.SymbolFlags.Function) {
				return collectFunction(symbol, type, context);
			}
		} else {
			let qualifiedName = context.checker.getFullyQualifiedName(symbol);
			if (typeToStdwebTypeMap.hasOwnProperty(qualifiedName)) {
				return typeToStdwebTypeMap[qualifiedName];
			}
		}

		return rustifyTypeUsingOnlyFlags(type);
	}

	let result = impl();
	let isOptional = symbol.flags & ts.SymbolFlags.Optional;
	if (isOptional) {
		result = makeRustifiedTypeOptional(result, context);
	}
	return result;
}

function collectSymbolEnclosingNamespaces(symbol:ts.Symbol, context:Context) : [Namespace,string] {
	let parsedFqn = parseFQN(context.checker.getFullyQualifiedName(symbol));
	let curNS = context.rootNameSpace;
	for (let i = 0; i < parsedFqn.length-1; i++) {
		curNS = curNS.getOrCreateSubNamespace(parsedFqn[i]);
	}
	return [curNS, parsedFqn[parsedFqn.length-1]];
}

/*function getSymbolEnclosingNamespace(symbol:ts.Symbol, context:Context) : [Namespace,string] | undefined {
	let parsedFqn = parseFQN(context.checker.getFullyQualifiedName(symbol));
	let curNS = context.rootNameSpace;
	for (let i = 0; i < parsedFqn.length-1; i++) {
		if (curNS.subNamespaces.hasOwnProperty(parsedFqn[i])) {
			curNS = curNS.subNamespaces[parsedFqn[i]];
		} else {
			return undefined;
		}
	}
	return [curNS, parsedFqn[parsedFqn.length-1]];
}*/

function collectSignature(signature: ts.Signature, context: Context) : Signature {
	let retType = collectType(signature.getReturnType(), context);
	let args : Variable[] = [];
	signature.parameters.forEach((param) => {
		let type = context.checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration!);
		let rustType = collectType(type, context);
		let isOptional = false;
		let hasDotDotDot = false;
		forEach(param.declarations, (paramDecl) => {
			if (ts.isParameter(paramDecl)) {
				if (context.checker.isOptionalParameter(paramDecl)) {
					isOptional = true;
				}
				if (paramDecl.dotDotDotToken !== undefined) {
					hasDotDotDot = true;
				}
			}
		});
		if (isOptional) {
			rustType = makeRustifiedTypeOptional(rustType, context);
		}
		if (!hasDotDotDot) {
			args.push(new Variable(param.name, context.checker.typeToString(type), escapeRustName(param.name), rustType, isOptional));
		}
	});
	return new Signature(args, retType, context.checker.typeToString(signature.getReturnType()));
}

function collectClosure(signature: Signature, context: Context) : RustifiedType {
	let fnName = signature.getRustTypeName(false);
	
	let existing = context.closures.find((sig) => { return sig.getRustTypeName(false) == fnName; });

	if (existing !== undefined) {
		return existing.rustifiedType;
	} else {
		context.closures.push(signature);
		return signature.rustifiedType;
	}
}

function collectFunction(symbol:ts.Symbol, type:ts.Type, context:Context) : RustifiedType {
	let [ns, name] = collectSymbolEnclosingNamespaces(symbol, context);

	let docs = symbol.getDocumentationComment(context.checker);

	//let result : Function[] = [];

	forEach(symbol.declarations, (decl) => {
		let functionType = context.checker.getTypeOfSymbolAtLocation(symbol, decl);
		forEach(functionType.getCallSignatures(), (callSig) => {
			let f = new Function(escapeRustName(symbol.name), undefined, collectSignature(callSig, context), docs);
			ns.addFunction(f, context);
			//result.push(f);
		});
	});

	return UnknownRustifiedType; // TODO: we can be more precise here
}

function collectMembers(obj: ClassOrInterface, context: Context) {
	let symbol = obj.symbol;
	let members = obj.type.getProperties();
	forEach(members, (memSym) => {
		let isPrivate = false;
		if (memSym.declarations !== undefined && memSym.declarations.length > 0) {
			let mods = memSym.declarations[0].modifiers;
			if (mods !== undefined) {
				isPrivate = mods.some((v) => v.kind == ts.SyntaxKind.ProtectedKeyword || v.kind == ts.SyntaxKind.PrivateKeyword);
			}
		}
		if (!isPrivate) {
			let memType = context.checker.getTypeOfSymbolAtLocation(memSym, memSym.valueDeclaration!);
			memType.getCallSignatures().forEach((callSig) => {
				obj.addMethod(new Function(escapeRustName(memSym.name), undefined, collectSignature(callSig, context), callSig.getDocumentationComment(context.checker)), context);
			});
			if (memSym.flags & ts.SymbolFlags.Property) {
				let memRustType = collectType(memType, context);
				let isOptional = ((memSym.flags & ts.SymbolFlags.Optional) != 0);
				if (isOptional) {
					memRustType = makeRustifiedTypeOptional(memRustType, context);
				}
				obj.properties.push(new Variable(memSym.name, context.checker.typeToString(memType), escapeRustName(memSym.name), memRustType, isOptional));
			}
		}
	});
}

function collectClass(symbol:ts.Symbol, type:ts.InterfaceType, context:Context) : Class {
	console.assert(type.isClass());

	let [ns, name] = collectSymbolEnclosingNamespaces(symbol, context);

	if (ns.classes.hasOwnProperty(name)) {
		return ns.classes[name];
	}

	let result = ns.getOrCreateClass(symbol, type, context);

	let bases = context.checker.getBaseTypes(type);
	bases.forEach((base) => {
		let baseSym = base.symbol;
		if (baseSym !== undefined) {
			if (base.isClass()) {
				if (result.superClass === undefined) {
					result.superClass = collectClass(baseSym, base, context);
				}
			} else if (base.isClassOrInterface()) {
				let i = collectInterface(baseSym, base, context);
				result.pushDirectImpl(i);
			}
		}
	});

	// the above code doesn't find the classes interfaces or constructors, so do it manually
	forEach(symbol.declarations, (decl) => {
		if (!ts.isClassDeclaration(decl)) {
			return;
		}
		if (symbol.name == "Sprite") {
			decl.members.forEach((mem) => {
				let isStaticMethod = false;
				if (mem.kind == ts.SyntaxKind.MethodDeclaration) {
					forEach(mem.modifiers, (modifier) => {
						if (modifier.kind == ts.SyntaxKind.StaticKeyword) {
							isStaticMethod = true;
						}
					});
					if (isStaticMethod) {
						let memType = context.checker.getTypeAtLocation(mem);
						if (memType.symbol) {
							let memName = memType.symbol.name;
							let memRustName = escapeRustName(memName);
							forEach(memType.getCallSignatures(), (callSig) => {
								let sig = collectSignature(callSig, context);
								result.addStaticMethod(new Function(memRustName, undefined, sig, callSig.getDocumentationComment(context.checker)), context);
							});
						}
					}
				}
			});
		}
		forEach(decl.heritageClauses, (her) => {
			if (her.token == ts.SyntaxKind.ImplementsKeyword) {
				forEach(her.types, (type) => {
					let implType = context.checker.getTypeAtLocation(type);
					let implSym = implType.symbol;
					if (implSym !== undefined) {
						if (implType.isClassOrInterface()) {
							let i = collectInterface(implSym, implType, context);
							result.pushDirectImpl(i);
						}
					}
				});
			}
		});
		let declName = decl.name;
		if (declName !== undefined) {
			let declNameType = context.checker.getTypeOfSymbolAtLocation(result.symbol, declName);
			let constructors = declNameType.getConstructSignatures();
			constructors.forEach((constructor) => {
				result.addConstructor(new Function("new", undefined, collectSignature(constructor, context), constructor.getDocumentationComment(context.checker)), context);
			});
		}
	});

	collectMembers(result, context);

	return result;
}

function collectInterface(symbol:ts.Symbol, type:ts.InterfaceType, context:Context) : Interface {
	let [ns, name] = collectSymbolEnclosingNamespaces(symbol, context);

	if (ns.interfaces.hasOwnProperty(name)) {
		return ns.interfaces[name];
	}

	let result = ns.getOrCreateInterface(symbol, type, context);

	let bases = context.checker.getBaseTypes(type);
	bases.forEach((base) => {
		let baseSym = base.symbol;
		if (baseSym !== undefined) {
			if (base.isClassOrInterface()) {
				let i = collectInterface(baseSym, base, context);
				result.pushDirectImpl(i);
			}
		}
	});

	collectMembers(result, context);

	return result;
}

let collectedSymbols = new Map<ts.Symbol, RustifiedType>();

function collectSymbol(symbol: ts.Symbol, context: Context): RustifiedType {
	let cached = collectedSymbols.get(symbol);
	if (cached !== undefined) {
		return cached;
	} else {
		let type = context.checker.getDeclaredTypeOfSymbol(symbol);
		let result = collectSymbolAndType(symbol, type, context);
		collectedSymbols.set(symbol, result);
		return result;
	}
}

function emitCargoToml(packageName: string) : string {
	return "" +
	"[package]\n" +
	"name = \""+packageName+"\"\n" +
	"version = \"1.0.0\"\n" +
	"authors = [\"dts2rs\"]\n" +
	"\n" + 
	"[dependencies.stdweb]\n" +
	"version = \"0.4\"\n" +
	"features = [\"experimental_features_which_may_break_on_minor_version_bumps\"]\n";
}

function numToAbc(num:number) : string {
	let neg = false;
	if (num < 0) {
		neg = true;
		num = -num;
	} else if (num == 0) {
		return "a";
	}
	let result = "";
	while (num > 0) {
		let digit = (num%26);
		num = Math.floor(num/26);
		result = String.fromCharCode(97+digit) + result;
	}
	if (neg) {
		result = "N"+result;
	}
	return result;
}

function forEachKeyValueInObject<T>(obj: {[key:string]:T}, cb: (key:string, value:T) => void) {
	for (const key in obj) {
		if (obj.hasOwnProperty(key)) {
			cb(key, obj[key]);
		}
	}
}

function forEach<T>(list:ReadonlyArray<T> | undefined, cb: (value:T, index:number, array:ReadonlyArray<T>) => void) {
	if (list !== undefined) {
		list.forEach(cb);
	}
}

function parseFQN(fqn:string) : string[] {
	return fqn.split(".").map((part) => {
		if (part.charCodeAt(0) == 34 /* " */ && part.charCodeAt(part.length-1) == 34 /* " */) {
			return part.substr(1, part.length-2);
		} else {
			return part;
		}
	}).map(escapeRustName);
}

function dts2rs(fileNames: string[], options: ts.CompilerOptions, outDir:string, packageName:string): void {
    // Build a program using the set of root file names in fileNames
	let program = ts.createProgram(fileNames, options);

    // Get the checker, we will use it to find more about classes
	let checker = program.getTypeChecker();

	let context : Context = {
		sourceFiles: fileNames,
		checker: checker,
		rootNameSpace: new Namespace(undefined, ""),
		closures: []
	};

	let ambientModules : ts.Symbol[] = [];
	checker.getAmbientModules().forEach((m) => {
		let shouldExport = false;
		forEach(m.getDeclarations(), (mDecl) => {
			let fileName = mDecl.getSourceFile().fileName;
			if (fileNames.indexOf(fileName) >= 0) {
				shouldExport = true;
			}
		});
		if (shouldExport) {
			forEach(checker.getExportsOfModule(m), (e) => {
				collectSymbol(e, context);
			});
			ambientModules.push(m);
		}
	});

	let hasTopLevelExports = false;
	for (const sourceFile of program.getSourceFiles()) {
		if (fileNames.indexOf(sourceFile.fileName) < 0) {
			continue;
		}
		let sfSymb = checker.getSymbolAtLocation(sourceFile);
		if (sfSymb !== undefined) {
			checker.getExportsOfModule(sfSymb).forEach((sfExp) => {
				collectSymbol(sfExp, context);
				hasTopLevelExports = true;
			});
		}
	}

	let outStr = "";
	
	let writeln = (s:string) => outStr += s+"\n";
	
	writeln("#![allow(non_camel_case_types, non_snake_case)]");
	writeln("");
	writeln("#[macro_use]");
	writeln("extern crate stdweb;");
	writeln("");
	writeln("pub struct Any<T: ::stdweb::JsSerialize>(pub T);");
	writeln("");
	writeln("#[doc(hidden)]");
	writeln("impl<T: ::stdweb::JsSerialize> ::stdweb::private::JsSerialize for Any<T> {");
	writeln("\t#[doc(hidden)]");
	writeln("\tfn _into_js< 'a >( &'a self ) -> ::stdweb::private::SerializedValue< 'a > {");
	writeln("\t\tself.0._into_js()");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("pub trait AsAny : Sized + ::stdweb::JsSerialize {");
	writeln("\tfn as_any(self) -> Any<Self>;");
	writeln("}");
	writeln("");
	writeln("impl<T> AsAny for T where T: ::stdweb::JsSerialize {");
	writeln("\tfn as_any(self) -> Any<T> {");
	writeln("\t\tAny(self)");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("fn __js_value_into_undefined(val: ::stdweb::Value) -> ::stdweb::Undefined {");
	writeln("\tif let ::stdweb::Value::Undefined = val {");
	writeln("\t\t::stdweb::Undefined");
	writeln("\t} else {");
	writeln("\t\tjs!(@(no_return) console.error(\"ERROR: expected JS code to return undefined, but it returned: \", @{val}));");
	writeln("\t\tpanic!(\"Can't unwrap JS value as undefined\")");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("fn __js_value_into_null(val: ::stdweb::Value) -> ::stdweb::Null {");
	writeln("\tif let ::stdweb::Value::Null = val {");
	writeln("\t\t::stdweb::Null");
	writeln("\t} else {");
	writeln("\t\tjs!(@(no_return) console.error(\"ERROR: expected JS code to return null, but it returned: \", @{val}));");
	writeln("\t\tpanic!(\"Can't unwrap JS value as null\")");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("fn __js_value_into_bool(val: ::stdweb::Value) -> bool {");
	writeln("\tif let ::stdweb::Value::Bool(b) = val {");
	writeln("\t\tb");
	writeln("\t} else {");
	writeln("\t\tjs!(@(no_return) console.error(\"ERROR: expected JS code to return a bool, but it returned: \", @{val}));");
	writeln("\t\tpanic!(\"Can't unwrap JS value as bool\")");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("fn __js_value_into_number(val: ::stdweb::Value) -> f64 {");
	writeln("\tif let ::stdweb::Value::Number(n) = val {");
	writeln("\t\t::stdweb::unstable::TryInto::try_into(n).unwrap()");
	writeln("\t} else {");
	writeln("\t\tjs!(@(no_return) console.error(\"ERROR: expected JS code to return a number, but it returned: \", @{val}));");
	writeln("\t\tpanic!(\"Can't unwrap JS value as number\")");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("fn __js_value_into_symbol(val: ::stdweb::Value) -> ::stdweb::Symbol {");
	writeln("\tif let ::stdweb::Value::Symbol(s) = val {");
	writeln("\t\ts");
	writeln("\t} else {");
	writeln("\t\tjs!(@(no_return) console.error(\"ERROR: expected JS code to return a symbol, but it returned: \", @{val}));");
	writeln("\t\tpanic!(\"Can't unwrap JS value as symbol\")");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("fn __js_value_into_string(val: ::stdweb::Value) -> String {");
	writeln("\tif let ::stdweb::Value::String(s) = val {");
	writeln("\t\ts");
	writeln("\t} else {");
	writeln("\t\tjs!(@(no_return) console.error(\"ERROR: expected JS code to return a string, but it returned: \", @{val}));");
	writeln("\t\tpanic!(\"Can't unwrap JS value as string\")");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("fn __js_value_into_reference(val: ::stdweb::Value, name: &str) -> ::stdweb::Reference {");
	writeln("\tif let ::stdweb::Value::Reference(r) = val {");
	writeln("\t\tr");
	writeln("\t} else {");
	writeln("\t\tjs!(@(no_return) console.error(\"ERROR: expected JS code to return a \"+@{name}+\", but it returned: \", @{val}));");
	writeln("\t\tpanic!(\"Can't unwrap JS value as reference\")");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("pub struct __UntypedJsFn(::stdweb::Reference);");
	writeln("");
	emitRefTypeTraits("__UntypedJsFn", writeln);
	writeln("/// If a type implements this trait that means that you can call it in JavaScript (with some unknown number of arguments).");
	writeln("pub trait __JsCallable : ::stdweb::JsSerialize {}");
	writeln("");
	writeln("impl __JsCallable for __UntypedJsFn {}");
	writeln("impl<'a> __JsCallable for &'a __UntypedJsFn {}");
	writeln("impl<T: ::stdweb::JsSerialize> __JsCallable for Any<T> {}");
	writeln("");

	context.closures.forEach((f) => {
		let fStructName = f.getRustTypeName(false);
		let fTraitName = f.getRustTypeName(true);
		writeln("pub struct "+fStructName+"(::stdweb::Reference);");
		writeln("");
		emitRefTypeTraits(fStructName, writeln);
		writeln("impl __JsCallable for "+fStructName+" {}");
		writeln("impl<'a> __JsCallable for &'a "+fStructName+" {}");
		writeln("");
		writeln("pub trait "+fTraitName+" : __JsCallable + ::stdweb::JsSerialize {");
		let fnDefLine = "\tfn call(&self";
		for (let i = 0; i < f.args.length; i++) {
			fnDefLine += ", arg"+(i+1)+": "+f.args[i].type.inArgPosName(context.rootNameSpace);
		}
		fnDefLine += ") -> "+f.returnType.structName(context.rootNameSpace)+" {";
		writeln(fnDefLine);
		let jsLine = "js!(return @{self}(";
		if (rustifiedTypesAreSame(f.returnType, UnitRustifiedType, context)) {
			jsLine = "js!(@(no_return) @{self}("
		}
		for (let i = 0; i < f.args.length; i++) {
			if (i != 0) {
				jsLine += ", ";
			}
			jsLine += "@{arg"+(i+1)+"}";
		}
		jsLine += ");)";
		writeln("\t\t"+f.returnType.fromJsValue(context.rootNameSpace, jsLine));
		writeln("\t}");
		writeln("}");
		writeln("");
		writeln("impl "+fTraitName+" for "+fStructName+" {}");
		writeln("impl<'a> "+fTraitName+" for &'a "+fStructName+" {}");
		writeln("impl<T: ::stdweb::JsSerialize> "+fTraitName+" for Any<T> {}");
		writeln("");
	});

	/*outStr += "pub trait "+CLASS_BASE_TRAITS+" : ::stdweb::private::JsSerialize + ::stdweb::private::JsSerializeOwned {\n";
	outStr += "\tfn __get_jsref(&self) -> ::stdweb::Reference;\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "impl "+CLASS_BASE_TRAIT+" for ::stdweb::Value {\n";
	outStr += "\tfn __get_jsref(&self) -> ::stdweb::Reference {\n";
	outStr += "\t\tif let ::stdweb::Reference(r) = self {\n";
	outStr += "\t\t\tr.clone()\n";
	outStr += "\t\t} else {\n";
	outStr += "\t\t\tpanic!(\"__get_jsref() called on non-reference!\")\n";
	outStr += "\t\t}\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "#[derive(Clone,Debug)]\n";
	outStr += "pub struct Any(pub ::stdweb::Value);\n";
	outStr += "\n";*/

	context.rootNameSpace.emit(writeln, context);

	writeln("pub mod prelude {");
	writeln("\tpub use Any;");
	writeln("\tpub use AsAny;");
	context.rootNameSpace.emitPrelude(indentAdder(writeln), context);
	context.closures.forEach((f) => {
		let fTraitName = f.getRustTypeName(true);
		writeln("\tpub use "+fTraitName+";");
	});
	writeln("}");

	ambientModules.forEach((ambientMod) => {
		let rustName = escapeRustName(ambientMod.name);
		writeln("/// Loads the library from the given url.");
		writeln("/// Returns a Promise.");
		writeln("pub fn __requireFromUrl__"+rustName+"(url: &str) -> ::stdweb::Promise {");
		writeln("\t::stdweb::Promise::from_thenable(&__js_value_into_reference(js!(return new Promise(function (resolve, reject) {");
		writeln("\t\tlet script = document.createElement(\"script\");");
		writeln("\t\tscript.type = \"text/javascript\";");
		writeln("\t\tscript.src = @{url};");
		writeln("\t\tscript.async = true;");
		writeln("\t\tscript.onload = resolve;");
		writeln("\t\tscript.onerror = reject;");
		writeln("\t\tdocument.head.appendChild(script);");
		writeln("\t});), \"promise\")).unwrap()");
		writeln("}");
	});

	/*outStr += "pub mod __statics {\n";
	outStr += "\tuse super::*;\n"
	context.rootNameSpace.emitStatics(indentAdder((s) => { outStr += s+"\n" }), context);
	outStr += "}\n";*/
	
	mkdirp.sync(path.join(outDir, "src"));
	
	fs.writeFile(path.join(outDir, "Cargo.toml"), emitCargoToml(packageName), undefined, (err) => {
		if (err) {
			console.error("Error writing Cargo.toml: "+err.message);
		}
	});

	fs.writeFile(path.join(outDir, "src", "lib.rs"), outStr, undefined, (err) => {
		if (err) {
			console.error("Error writing lib.rs: "+err.message);
		}
	});

	return;

    /** Serialize a symbol into a json object */
    function serializeSymbol(symbol: ts.Symbol) {
		//console.log("Symbol "+symbol.getName()+", docs: "+ts.displayPartsToString(symbol.getDocumentationComment(checker))+", type "+checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!)));
    }

    /** Serialize a class symbol information */
    function serializeClass(symbol: ts.Symbol) {
        serializeSymbol(symbol);

        // Get the construct signatures
        let constructorType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!);
        //console.log("constructors: "+constructorType.getConstructSignatures().map(serializeSignature));
    }

    /** Serialize a signature (call or construct) */
    function serializeSignature(signature: ts.Signature) {
        return {
            parameters: signature.parameters.map(serializeSymbol),
            returnType: checker.typeToString(signature.getReturnType()),
            documentation: ts.displayPartsToString(signature.getDocumentationComment(checker))
        };
    }

    /** True if this is visible outside this file, false otherwise */
    function isNodeExported(node: ts.Node): boolean {
        return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0 || (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile);
    }
}

{
	let testDir = "test/pixi.js";
	//let testDir = "test/react";
	let tsconfigFile = testDir+"/tsconfig.json";
	let dtsFile = testDir+"/index.d.ts";
	let outDir = testDir+"/output";
	
	let config = readTsConfig(tsconfigFile, testDir);
	if (config) {
		dts2rs([dtsFile], config.options, outDir, "pixi-js");
	}
}

/*{
	let testDir = "test/react";
	//let testDir = "test/react";
	let tsconfigFile = testDir+"/tsconfig.json";
	let dtsFile = testDir+"/index.d.ts";
	let outDir = testDir+"/output";
	
	let config = readTsConfig(tsconfigFile, testDir);
	if (config) {
		dts2rs([dtsFile], config.options, outDir);
	}
}*/
