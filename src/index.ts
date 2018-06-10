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
			return s;
		} else {
			return writeln("\t"+s);
		}
	};
}

function emitImplJsSerializeForType(rustName: string, writeln: (s:string) => void) {
	writeln("#[doc(hidden)]");
	writeln("impl ::stdweb::private::JsSerialize for "+rustName+" {");
	writeln("\t#[doc(hidden)]");
	writeln("\tfn _into_js< 'a >( &'a self, arena: &'a ::stdweb::private::PreallocatedArena ) -> ::stdweb::private::SerializedValue< 'a > {");
	writeln("\t\tself.0._into_js(arena)");
	writeln("\t}");
	writeln("\t#[doc(hidden)]");
	writeln("\tfn _memory_required( &self ) -> usize {");
	writeln("\t\tself.0._memory_required()");
	writeln("\t}");
	writeln("}");
	writeln("");
	/*writeln("#[doc(hidden)]");
	writeln("impl ::stdweb::private::JsSerializeOwned for "+rustName+" {");
	writeln("\t#[doc(hidden)]");
	writeln("\tfn into_js_owned< 'a >( value: &'a mut Option< Self >, arena: &'a ::stdweb::private::PreallocatedArena ) -> ::stdweb::private::SerializedValue< 'a > {");
	writeln("\t\t::stdweb::private::JsSerializeOwned::into_js_owned(value.map(|v| v.0), arena)");
	writeln("\t}");
	writeln("\t#[doc(hidden)]");
	writeln("\tfn memory_required_owned( &self ) -> usize {");
	writeln("\t\tself.0.memory_required_owned()");
	writeln("\t}");
	writeln("}");
	writeln("");*/
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

	private methods: Function[];
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
		if (this._resolvedMethods.length == this.methods.length) {
			return this._resolvedMethods;
		} else {
			let result : Function[] = [];
			forEachFunctionWithUniqueNames(this.methods, (f, uniqueName) => {
				result.push(new Function(uniqueName, f.signature));
			});
			this._resolvedMethods = result;
			return result;
		}
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

		this.superClassOfTrait = escapeRustName("__SuperClassOf_"+symbol.name);
		this.superClass = undefined;

		this.rustifiedType = {
			fromJsValue: (ns: Namespace, s:string) => ns.getRustPathTo(this.namespace, this.rustName)+"(__js_value_into_reference("+s+"))",
			structName: (ns: Namespace) => ns.getRustPathTo(this.namespace, this.rustName),
			inArgPosName: (ns: Namespace) => "impl "+ns.getRustPathTo(this.namespace, this.superClassOfTrait)
		}
	}

	superClassOfTrait: string;
	superClass: Class | undefined;
	rustifiedType: RustifiedType;

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
		writeln("pub trait "+this.superClassOfTrait+":");
		writeln("\t"+CLASS_BASE_TRAITS+" +");
		if (this.superClass !== undefined) {
			writeln("\t"+this.namespace.getRustPathTo(this.superClass.namespace, this.superClass.superClassOfTrait)+" +");
		}
		for (let i of this.directImpls) {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		}
		/*this.forEachSuperClass((c) => {
			writeln("\t"+this.namespace.getRustPathTo(c.namespace, c.superClassOfTrait)+" +");
		});
		this.forEachSuperImpl((i) => {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		});*/
		writeln("{");
		this.getResolvedMethods().forEach((method) => {
			method.emit(indentAdder(writeln), true, true, this.namespace, context);
		});
		this.properties.forEach((prop) => {
			writeln("\tfn __get_"+prop.rustName+"(&self) -> "+prop.type.structName(this.namespace)+" {");
			writeln("\t\t"+prop.type.fromJsValue(this.namespace, "js!(return @{self}."+prop.jsName+";)"));
			writeln("\t}");
			writeln("\tfn __set_"+prop.rustName+"(&self, "+prop.rustName+": "+prop.type.inArgPosName(this.namespace)+") {");
			writeln("\t\tjs!(@(no_return) @{self}."+prop.jsName+" = @{"+prop.rustName+"};);");
			writeln("\t}");
			writeln("");
		});
		writeln("}");
		writeln("");

		emitImplJsSerializeForType(this.rustName, writeln);

		this.forEachSuperClass((superClass) => {
			writeln("impl "+ this.namespace.getRustPathTo(superClass.namespace, superClass.superClassOfTrait) +" for "+this.rustName+" {");
			/*superClass.getResolvedMethods().forEach((method) => {
				method.emit(indentAdder(writeln), true, true, this.namespace, context);
			})*/
			writeln("}");
			writeln("");
		});
		this.forEachSuperImpl((i) => {
			writeln("impl "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for "+this.rustName+" {");
			/*i.getResolvedMethods().forEach((method) => {
				method.emit(indentAdder(writeln), true, true, this.namespace, context);
			})*/
			writeln("}");
			writeln("");
		});
		
		writeln("impl "+ this.superClassOfTrait +" for "+this.rustName+" {");
		/*this.getResolvedMethods().forEach((method) => {
			method.emit(indentAdder(writeln), true, true, this.namespace, context);
		});*/
		writeln("}");

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
}

class Interface extends ClassOrInterface {
	constructor(public symbol: ts.Symbol, public type: ts.InterfaceType, public namespace: Namespace, public context: Context) {
		super(symbol, type, namespace, context);
		this.implementsTrait = escapeRustName("__Implements_"+symbol.name);

		this.rustifiedType = {
			fromJsValue: (ns: Namespace, s:string) => ns.getRustPathTo(this.namespace, this.rustName)+"(__js_value_into_reference("+s+"))",
			structName: (ns: Namespace) => ns.getRustPathTo(this.namespace, this.rustName),
			inArgPosName: (ns: Namespace) => "impl "+ns.getRustPathTo(this.namespace, this.implementsTrait)
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
		/*this.forEachSuperImpl((i) => {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		});*/
		writeln("{");
		this.getResolvedMethods().forEach((method) => {
			method.emit(indentAdder(writeln), true, true, this.namespace, context);
		})
		writeln("}");
		writeln("");
		emitImplJsSerializeForType(this.rustName, writeln);
		this.forEachSuperImpl((i) => {
			writeln("impl "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for "+this.rustName+" {");
			/*i.getResolvedMethods().forEach((method) => {
				method.emit(indentAdder(writeln), true, true, this.namespace, context);
			})*/
			writeln("}");
			writeln("");
		});
	}
}

class Variable {
	constructor(public jsName: string, public rustName: string, public type: RustifiedType) {}

	isSameAs(other: Variable, context: Context) : boolean {
		return this.rustName == other.rustName && rustifiedTypesAreSame(this.type, other.type, context);
	}
}

class Signature {
	constructor(public args: Variable[], public returnType: RustifiedType, public namespace: Namespace) {}

	isSameAs(other: Signature, context: Context) : boolean {
		if (this.namespace != other.namespace) {
			return false;
		}
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
}

class Function {
	constructor(public rustName: string, public signature: Signature) {}

	isSameAs(other: Function, context: Context) : boolean {
		if (this.rustName != other.rustName) {
			return false;
		}
		if (!this.signature.isSameAs(other.signature, context)) {
			return false;
		}
		return true;
	}
	

	emit(writeln: (s:string) => void, isMethod: boolean, withImplementation: boolean, namespace: Namespace, context: Context) {
		{
			let line = "fn "+this.rustName+"(";
			let isFirstParam = true;
			if (isMethod) {
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
			if (isMethod) {
				jsLine += "@{self}.";
			}
			jsLine += this.rustName+"(";
			let isFirstParam = true;
			this.signature.args.forEach((arg) => {
				if (!isFirstParam) {
					jsLine += ", ";
				}
				isFirstParam = false;
				jsLine += "@{"+arg.rustName+"}";
			});
			jsLine += "))";
			line += this.signature.returnType.fromJsValue(namespace, jsLine);
			writeln(line);
			writeln("}");
			writeln("");
		}
	}
}

class Namespace {
	constructor(public parent: Namespace | undefined, public name: string) {
		if (this.name === "" && this.parent !== undefined) {
			console.error("Namespace without name found that isn't the root namespace!");
			console.error("Parent: "+this.parent.toStringFull());
			throw "terminating...";
		}
		this.rustName = escapeRustName(this.name);
		this.subNamespaces = {};
		this.classes = {};
		this.interfaces = {};
		this.functions = {};
	}

	rustName: string;
	subNamespaces: {[name:string]: Namespace};
	classes: {[name:string]: Class};
	interfaces: {[name:string]: Interface};
	functions: {[name:string]: Function};

	toStringFull() : string {
		if (this.name == "") {
			return "the root namespace";
		} else if (this.parent === undefined) {
			return "namespace "+this.name;
		} else {
			return this.parent.toStringFull() + "::" + this.name;
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
				if (node.name !== "") {
					if (pathSoFar != "") {
						rec(node.parent, node.name + "::" + pathSoFar);
					} else {
						rec(node.parent, node.name);
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
			subNS.emit((s) => {
				if (s == "") {
					writeln(s);
				} else {
					writeln("\t"+s);
				}
			}, context);
			writeln("}");
		});

		forEachKeyValueInObject(this.classes, (className, theClass) => {
			theClass.emit(writeln, context);
		});

		forEachKeyValueInObject(this.interfaces, (className, theInterface) => {
			theInterface.emit(writeln, context);
		});
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
	if (rustKeywords.hasOwnProperty(name)) {
		name = name+"__";
	}
	let newName = "";
	for (let i = 0; i < name.length; i++) {
		let c = name.charCodeAt(i);
		if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57 && i > 0) || c == 95) {
			newName += String.fromCharCode(c);
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
			fromJsValue: (ns: Namespace, s:string) => "unsafe {<::stdweb::web::"+val+" as ::stdweb::ReferenceType>::from_reference_unchecked(__js_value_into_reference("+s+"))}",
			structName: (ns: Namespace) => "::stdweb::web::"+val,
			inArgPosName: (ns: Namespace) => "::stdweb::web::"+val,
		};
	}

	add("HTMLCanvasElement", "html_element::CanvasElement");
	// TODO: add the rest
}

interface RustifiedType {
	fromJsValue: (ns: Namespace, jsCode: string) => string,
	structName: (ns: Namespace) => string,
	inArgPosName: (ns: Namespace) => string
}

const AnyRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => s,
	structName: (ns: Namespace) => "::stdweb::Value",
	inArgPosName: (ns: Namespace) => "::stdweb::Value"
}

const NumberRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_number("+s+")",
	structName: (ns: Namespace) => "f64",
	inArgPosName: (ns: Namespace) => "f64"
}

const StringRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_string("+s+")",
	structName: (ns: Namespace) => "String",
	inArgPosName: (ns: Namespace) => "String"
}

const BoolRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_bool("+s+")",
	structName: (ns: Namespace) => "bool",
	inArgPosName: (ns: Namespace) => "bool"
}

const SymbolRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_symbol("+s+")",
	structName: (ns: Namespace) => "::stdweb::Symbol",
	inArgPosName: (ns: Namespace) => "::stdweb::Symbol",
}

const UndefinedRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_undefined("+s+")",
	structName: (ns: Namespace) => "::stdweb::Undefined",
	inArgPosName: (ns: Namespace) => "::stdweb::Undefined",
}

const NullRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => "__js_value_into_null("+s+")",
	structName: (ns: Namespace) => "::stdweb::Null",
	inArgPosName: (ns: Namespace) => "::stdweb::Null",
}

const UnitRustifiedType : RustifiedType = {
	fromJsValue: (ns: Namespace, s:string) => s+";",
	structName: (ns: Namespace) => "()",
	inArgPosName: (ns: Namespace) => "()",
}

let collectedTypes = new Map<ts.Type, RustifiedType>();

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
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.Object) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.Union) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.Intersection) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.Index) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.IndexedAccess) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.Conditional) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.Substitution) {
		return AnyRustifiedType;
	} else if (f & ts.TypeFlags.NonPrimitive) {
		return AnyRustifiedType;
	} else {
		return AnyRustifiedType;
	}
}

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
				return AnyRustifiedType;
			}
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
	let shouldOutputType = false;
	let decls = symbol.getDeclarations();
	if (decls !== undefined) {
		for (const decl of decls) {
			let fileName = decl.getSourceFile().fileName;
			if (context.sourceFiles.indexOf(fileName) >= 0) {
				shouldOutputType = true;
			} else {
				let qualifiedName = context.checker.getFullyQualifiedName(symbol);
				if (typeToStdwebTypeMap.hasOwnProperty(qualifiedName)) {
					return typeToStdwebTypeMap[qualifiedName];
				}
			}
		}
	}

	if (shouldOutputType) {
		if (type.isClass()) {
			return collectClass(symbol, type, context).rustifiedType;
		} else if (type.isClassOrInterface()) {
			return collectInterface(symbol, type, context).rustifiedType;
		}
	}

	return rustifyTypeUsingOnlyFlags(type);
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

function collectSignature(signature: ts.Signature, ns: Namespace, context: Context) : Signature {
	let retType = collectType(signature.getReturnType(), context);
	let args = signature.parameters.map((param) => {
		let type = context.checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration!);
		return new Variable(param.name, escapeRustName(param.name), collectType(type, context));
	});
	return new Signature(args, retType, ns);
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
				obj.addMethod(new Function(escapeRustName(memSym.name), collectSignature(callSig, obj.namespace, context)), context);
			});
			if (memSym.flags & ts.SymbolFlags.Property) {
				obj.properties.push(new Variable(memSym.name, escapeRustName(memSym.name), collectType(memType, context)));
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

	// the above code doesn't find the classes interfaces, so do it manually
	forEach(symbol.declarations, (decl) => {
		if (ts.isClassDeclaration(decl)) {
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
	"[dependencies]\n" +
	"stdweb = \"0.4\"\n";
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

function dts2rs(fileNames: string[], options: ts.CompilerOptions, outDir:string): void {
    // Build a program using the set of root file names in fileNames
	let program = ts.createProgram(fileNames, options);

    // Get the checker, we will use it to find more about classes
	let checker = program.getTypeChecker();

	let context : Context = {
		sourceFiles: fileNames,
		checker: checker,
		rootNameSpace: new Namespace(undefined, "")
	};

	let modules = checker.getAmbientModules();
	modules.forEach((m) => {
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
		}
	});

	for (const sourceFile of program.getSourceFiles()) {
		if (fileNames.indexOf(sourceFile.fileName) < 0) {
			continue;
		}
		let sfSymb = checker.getSymbolAtLocation(sourceFile);
		if (sfSymb !== undefined) {
			checker.getExportsOfModule(sfSymb).forEach((sfExp) => {
				collectSymbol(sfExp, context);
			});
		}
	}

	let outStr = "#![allow(non_camel_case_types, non_snake_case, unused_imports)]\n";
	outStr += "\n";
	outStr += "#[macro_use]\n";
	outStr += "extern crate stdweb;\n";
	outStr += "\n";
	outStr += "fn __js_value_into_undefined(val: ::stdweb::Value) -> ::stdweb::Undefined {\n";
	outStr += "\tif let ::stdweb::Value::Undefined = val {\n";
	outStr += "\t\t::stdweb::Undefined\n";
	outStr += "\t} else {\n";
	outStr += "\t\tjs!(console.error(\"ERROR: expected JS code to return undefined, but it returned: \", @{val}));\n";
	outStr += "\t\tpanic!(\"Can't unwrap JS value as undefined\")\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "fn __js_value_into_null(val: ::stdweb::Value) -> ::stdweb::Null {\n";
	outStr += "\tif let ::stdweb::Value::Null = val {\n";
	outStr += "\t\t::stdweb::Null\n";
	outStr += "\t} else {\n";
	outStr += "\t\tjs!(console.error(\"ERROR: expected JS code to return null, but it returned: \", @{val}));\n";
	outStr += "\t\tpanic!(\"Can't unwrap JS value as null\")\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "fn __js_value_into_bool(val: ::stdweb::Value) -> bool {\n";
	outStr += "\tif let ::stdweb::Value::Bool(b) = val {\n";
	outStr += "\t\tb\n";
	outStr += "\t} else {\n";
	outStr += "\t\tjs!(console.error(\"ERROR: expected JS code to return a bool, but it returned: \", @{val}));\n";
	outStr += "\t\tpanic!(\"Can't unwrap JS value as bool\")\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "fn __js_value_into_number(val: ::stdweb::Value) -> f64 {\n";
	outStr += "\tif let ::stdweb::Value::Number(n) = val {\n";
	outStr += "\t\t::stdweb::unstable::TryInto::try_into(n).unwrap()\n";
	outStr += "\t} else {\n";
	outStr += "\t\tjs!(console.error(\"ERROR: expected JS code to return a number, but it returned: \", @{val}));\n";
	outStr += "\t\tpanic!(\"Can't unwrap JS value as number\")\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "fn __js_value_into_symbol(val: ::stdweb::Value) -> ::stdweb::Symbol {\n";
	outStr += "\tif let ::stdweb::Value::Symbol(s) = val {\n";
	outStr += "\t\ts\n";
	outStr += "\t} else {\n";
	outStr += "\t\tjs!(console.error(\"ERROR: expected JS code to return a symbol, but it returned: \", @{val}));\n";
	outStr += "\t\tpanic!(\"Can't unwrap JS value as symbol\")\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "fn __js_value_into_string(val: ::stdweb::Value) -> String {\n";
	outStr += "\tif let ::stdweb::Value::String(s) = val {\n";
	outStr += "\t\ts\n";
	outStr += "\t} else {\n";
	outStr += "\t\tjs!(console.error(\"ERROR: expected JS code to return a string, but it returned: \", @{val}));\n";
	outStr += "\t\tpanic!(\"Can't unwrap JS value as string\")\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "fn __js_value_into_reference(val: ::stdweb::Value) -> ::stdweb::Reference {\n";
	outStr += "\tif let ::stdweb::Value::Reference(r) = val {\n";
	outStr += "\t\tr\n";
	outStr += "\t} else {\n";
	outStr += "\t\tjs!(console.error(\"ERROR: expected JS code to return a reference, but it returned: \", @{val}));\n";
	outStr += "\t\tpanic!(\"Can't unwrap JS value as reference\")\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
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
	outStr += "\n";*/
	outStr += "#[derive(Clone,Debug)]\n";
	outStr += "pub struct Any(::stdweb::Value);\n";
	outStr += "\n";
	context.rootNameSpace.emit((s) => { outStr += s+"\n" }, context);
	
	mkdirp.sync(path.join(outDir, "src"));
	
	fs.writeFile(path.join(outDir, "Cargo.toml"), emitCargoToml("pixi-js"), undefined, (err) => {
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
		dts2rs([dtsFile], config.options, outDir);
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
