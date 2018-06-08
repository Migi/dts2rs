import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as mkdirp from "mkdirp";
import { escape, parse } from "querystring";

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

class ClassOrInterface {
	constructor(public symbol: ts.Symbol, public type: ts.InterfaceType, public namespace: Namespace, public context: Context) {
		this.name = symbol.name;
		this.rustName = escapeRustName(this.name);
		this.directImpls = [];
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
	}

	superClassOfTrait: string;
	superClass: Class | undefined;

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
		let checker = context.checker;
		this.emitDocs(writeln, context);
		writeln("pub struct "+this.rustName+"(::stdweb::Reference);");
		writeln("");
		writeln("pub trait "+this.superClassOfTrait+":");
		//writeln("\t"+BASE_TRAIT_NAME+" +");
		this.forEachSuperClass((c) => {
			writeln("\t"+this.namespace.getRustPathTo(c.namespace, c.superClassOfTrait)+" +");
		});
		this.forEachSuperImpl((i) => {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		});
		writeln("{}");
		writeln("");
		this.forEachSuperClass((superClass) => {
			writeln("impl "+ this.namespace.getRustPathTo(superClass.namespace, superClass.superClassOfTrait) +" for "+this.rustName+" {");
			writeln("}");
			writeln("");
		});
		this.forEachSuperImpl((i) => {
			writeln("impl "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for "+this.rustName+" {");
			writeln("}");
			writeln("");
		});

		/*let members = this.symbol.members;
		if (members !== undefined) {
			members.forEach((mem) => {
				console.log(" - "+mem.name);
			});
		}*/

		forEach(this.symbol.getDeclarations(), (decl) => {
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
						
						//line += escapeRustName(constructorParam.name) + ": " + rustifyType(checker.getDeclaredTypeOfSymbol(constructorParam), context) + ", ";
						line += escapeRustName(constructorParam.name) + ": " + rustifyType(checker.getTypeOfSymbolAtLocation(constructorParam, constructorParam.valueDeclaration!), this.namespace, context);
					});

					line += ") -> "+this.rustName+" {";

					writeln(line);
				}
				{
					let line = "\tjs!(new "+checker.getFullyQualifiedName(this.symbol) + "(";
					let firstParam = true;
					constructor.parameters.forEach((constructorParam) => {
						if (!firstParam) {
							line += ", ";
						}
						firstParam = false;
						line += "@{"+escapeRustName(constructorParam.name)+"}";
					});
					line += "))";
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
			}*/
		});
	}
}

class Interface extends ClassOrInterface {
	constructor(public symbol: ts.Symbol, public type: ts.InterfaceType, public namespace: Namespace, public context: Context) {
		super(symbol, type, namespace, context);
		this.implementsTrait = escapeRustName("__Implements_"+symbol.name);
	}

	implementsTrait : string;

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
		writeln("pub struct "+this.rustName+"(::stdweb::Reference);");
		writeln("");
		writeln("pub trait "+this.implementsTrait+":");
		//writeln("\t"+BASE_TRAIT_NAME+" +");
		this.forEachSuperImpl((i) => {
			writeln("\t"+this.namespace.getRustPathTo(i.namespace, i.implementsTrait)+" +");
		});
		writeln("{}");
		writeln("");
		this.forEachSuperImpl((i) => {
			writeln("impl "+ this.namespace.getRustPathTo(i.namespace, i.implementsTrait) +" for "+this.rustName+" {");
			writeln("}");
			writeln("");
		});
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
			subNS.emit((s) => writeln("\t"+s), context);
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

const BASE_TRAIT_NAME = "__WrapsJsRef";

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

let typeToStdwebTypeMap : {[key:string]: string} = {};
{
	function add(key:string, val:string) {
		typeToStdwebTypeMap[key] = "::stdweb::web::"+val;
	}

	add("HTMLCanvasElement", "html_element::CanvasElement");
	// TODO: add the rest
}

function rustifyType(t:ts.Type, curNamespace: Namespace, context:Context) : string | undefined {
	let f = t.flags;
	let symbol = undefined;
	if (t.aliasSymbol !== undefined) {
		symbol = t.aliasSymbol;
	} else if (t.symbol !== undefined) {
		symbol = t.symbol;
	}
	if (symbol !== undefined) {
		let decls = symbol.getDeclarations();
		if (decls !== undefined) {
			for (const decl of decls) {
				let fileName = decl.getSourceFile().fileName;
				if (context.sourceFiles.indexOf(fileName) >= 0) {
					let qualifiedName = context.checker.getFullyQualifiedName(symbol);
					let hasEnclosingNS = getSymbolEnclosingNamespace(symbol, context);
					if (hasEnclosingNS !== undefined) {
						let [enclosingNS, rustName] = hasEnclosingNS;
						if (enclosingNS.classes.hasOwnProperty(rustName)) {
							return "impl "+curNamespace.getRustPathTo(enclosingNS, enclosingNS.classes[rustName].superClassOfTrait);
						} else if (enclosingNS.interfaces.hasOwnProperty(rustName)) {
							return "impl "+curNamespace.getRustPathTo(enclosingNS, enclosingNS.interfaces[rustName].implementsTrait);
						}
					}
				} else {
					let qualifiedName = context.checker.getFullyQualifiedName(symbol);
					if (qualifiedName == symbol.name) {
						if (typeToStdwebTypeMap.hasOwnProperty(qualifiedName)) {
							return typeToStdwebTypeMap[qualifiedName];
						}
					}
				}
			}
		}
	}
	if (f & ts.TypeFlags.Any) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.String) {
		return "String";
	} else if (f & ts.TypeFlags.Number) {
		return "f64";
	} else if (f & ts.TypeFlags.Boolean) {
		return "bool";
	} else if (f & ts.TypeFlags.Enum) {
		return "f64";
	} else if (f & ts.TypeFlags.StringLiteral) {
		return "String";
	} else if (f & ts.TypeFlags.NumberLiteral) {
		return "f64";
	} else if (f & ts.TypeFlags.BooleanLiteral) {
		return "bool";
	} else if (f & ts.TypeFlags.EnumLiteral) {
		return "f64";
	} else if (f & ts.TypeFlags.ESSymbol) {
		return "::stdweb::Symbol";
	} else if (f & ts.TypeFlags.UniqueESSymbol) {
		return "::stdweb::Symbol";
	} else if (f & ts.TypeFlags.Void) {
		return "()";
	} else if (f & ts.TypeFlags.Undefined) {
		return "::stdweb::Undefined";
	} else if (f & ts.TypeFlags.Null) {
		return "::stdweb::Null";
	} else if (f & ts.TypeFlags.Never) {
		return "()";
	} else if (f & ts.TypeFlags.TypeParameter) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.Object) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.Union) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.Intersection) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.Index) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.IndexedAccess) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.Conditional) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.Substitution) {
		return "::stdweb::Value";
	} else if (f & ts.TypeFlags.NonPrimitive) {
		return "::stdweb::Value";
	} else {
		return "::stdweb::Value";
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

function collectSymbolEnclosingNamespaces(symbol:ts.Symbol, context:Context) : [Namespace,string] {
	let parsedFqn = parseFQN(context.checker.getFullyQualifiedName(symbol));
	let curNS = context.rootNameSpace;
	for (let i = 0; i < parsedFqn.length-1; i++) {
		curNS = curNS.getOrCreateSubNamespace(parsedFqn[i]);
	}
	return [curNS, parsedFqn[parsedFqn.length-1]];
}

function getSymbolEnclosingNamespace(symbol:ts.Symbol, context:Context) : [Namespace,string] | undefined {
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
	})

	return result;
}

function collect(symbol: ts.Symbol, context: Context) {
	// ugly hack because for some reason getDeclaredTypeOfSymbol(symbol) doesn't have construct signatures...
	/*let type_ : undefined | ts.Type = undefined;
	forEach(symbol.declarations, (decl) => {
		if (type_ == undefined) {
			if (ts.isClassDeclaration(decl) && decl.name) {
				type_ = context.checker.getTypeOfSymbolAtLocation(symbol, decl.name);
			}
		}
	});
	let type = (type_ == undefined ? context.checker.getDeclaredTypeOfSymbol(symbol) : type_);*/
	let type = context.checker.getDeclaredTypeOfSymbol(symbol);

	/*if (symbol.name == "Application") {
		type.is
		console.log(type.flags);
	}*/

	if (type.isClass()) {
		collectClass(symbol, type, context);
	} else if (type.isClassOrInterface()) {
		collectInterface(symbol, type, context);
	}
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
				collect(e, context);
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
				collect(sfExp, context);
			});
		}
	}

	let outStr = "#![allow(non_camel_case_types, non_snake_case, unused_imports)]\n";
	outStr += "\n";
	outStr += "#[macro_use]\n";
	outStr += "extern crate stdweb;\n";
	outStr += "\n";
	outStr += "pub trait "+BASE_TRAIT_NAME+" : ::stdweb::private::JsSerialize + ::stdweb::private::JsSerializeOwned {\n";
	outStr += "\tfn __get_jsref(&self) -> ::stdweb::Reference;\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "impl "+BASE_TRAIT_NAME+" for ::stdweb::Value {\n";
	outStr += "\tfn __get_jsref(&self) -> ::stdweb::Reference {\n";
	outStr += "\t\tif let ::stdweb::Value::Reference(r) = self {\n";
	outStr += "\t\t\tr.clone()\n";
	outStr += "\t\t} else {\n";
	outStr += "\t\t\tpanic!(\"__get_jsref() called on non-reference!\")\n";
	outStr += "\t\t}\n";
	outStr += "\t}\n";
	outStr += "}\n";
	outStr += "\n";
	outStr += "\n";
	outStr += "#[derive(Clone,Debug)]\n";
	outStr += "pub struct Any(::stdweb::Value);\n";
	outStr += "\n";
	context.rootNameSpace.emit((s) => { outStr += s+"\n" }, context);
	
	mkdirp.sync(path.join(outDir, "src"));
	
	fs.writeFile(path.join(outDir, "Cargo.toml"), emitCargoToml("dts2rs-generated-code"), undefined, (err) => {
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
