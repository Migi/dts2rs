import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as mkdirp from "mkdirp";
import { escape } from "querystring";

interface Context {
	sourceFiles: string[],
	checker: ts.TypeChecker
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

type Item = Class | Interface | Function | Namespace;
type NameMap = {[name: string]: Item[]};

function nameMapPush(nameMap:NameMap, item:Item) {
	let name = item.name;
	if (nameMap.hasOwnProperty(name)) {
		nameMap[name].push(item);
	} else {
		nameMap[name] = [item];
	}
}

class BaseItem {
	constructor(public symbol: ts.Symbol, public nameNode: ts.Node, context: Context) {
		this.name = symbol.getName();
		this.rustName = escapeRustName(this.name);
		this.fullyQualifiedName = context.checker.getFullyQualifiedName(symbol);
		this.rustFullyQualifiedName = rustifyFullyQualifiedName(this.fullyQualifiedName);
	}
	name: string;
	rustName: string;
	fullyQualifiedName: string;
	rustFullyQualifiedName: string;
}

class Class extends BaseItem {
	constructor(public classDecl: ts.ClassDeclaration, symbol: ts.Symbol, nameNode: ts.Node, context: Context) {
		super(symbol, nameNode, context);

		let checker = context.checker;

		this.type = checker.getTypeOfSymbolAtLocation(symbol, nameNode);

		this.superClass = undefined;
		this.directImpls = [];

		let heritageClauses = this.classDecl.heritageClauses;
		if (heritageClauses !== undefined) {
			heritageClauses.forEach((clause) => {
				clause.types.forEach((baseTypeExpr) => {
					let baseType = checker.getTypeFromTypeNode(baseTypeExpr);
					if (baseType.isClass()) {
						//baseType.
					}
					if (baseType.symbol !== undefined) {
						let baseTypeDecls = baseType.symbol.declarations;
						if (baseTypeDecls !== undefined) {
							/*if (clause.token == ts.SyntaxKind.ExtendsKeyword) {
								this.superClass = 
							} else {
								writeln("\t"+rustifyFullyQualifiedName(checker.getFullyQualifiedName(baseType.symbol))+" +");
							}*/
						}
					}
				});
			});
		}

		this.allSuperClasses = {};
		/*if (superClass !== undefined) {
			Object.assign(this.allSuperClasses, superClass.allSuperClasses);
			this.allSuperClasses[superClass.fullyQualifiedName] = superClass;
		}*/
		this.allImpls = {};
		/*for (let impl of thisImplements) {
			Object.assign(this.allImpls, impl.allSuperIterfaces);
		}
		for (let impl of thisImplements) {
			this.allImpls[impl.fullyQualifiedName] = impl;
		}*/
	}

	type: ts.Type;
	superClass: Class | undefined;
	directImpls: Interface[];
	allSuperClasses: {[fullyQualifiedName: string]: Class};
	allImpls: {[fullyQualifiedName: string]: Interface};
}

class Function extends BaseItem {
	constructor(symbol: ts.Symbol, nameNode: ts.Node, context: Context) {
		super(symbol, nameNode, context);
	}
}

class Interface extends BaseItem {
	constructor(symbol: ts.Symbol, nameNode: ts.Node, public directSuperInterfaces: Interface[], context: Context) {
		super(symbol, nameNode, context);
		this.allSuperIterfaces = {};
		for (let impl of directSuperInterfaces) {
			Object.assign(this.allSuperIterfaces, impl.allSuperIterfaces);
		}
		for (let impl of directSuperInterfaces) {
			this.allSuperIterfaces[impl.fullyQualifiedName] = impl;
		}
	}
	allSuperIterfaces: {[fullyQualifiedName: string]: Interface};
}

class TypeAlias extends BaseItem {
	constructor(symbol: ts.Symbol, nameNode: ts.Node, context: Context) {
		super(symbol, nameNode, context);
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

function rustifyType(t:ts.Type, shouldBoxTrait:boolean, context:Context) : string | undefined {
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
					if (qualifiedName !== undefined && qualifiedName !== "__type") {
						let rustName = rustifyFullyQualifiedName(qualifiedName);
						if (shouldBoxTrait) {
							return "Box<"+rustName+">";
						} else {
							return "impl "+rustName;
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

function emitNamespace(ns:Namespace, writeln: (s:string) => void, context:Context) {
	let checker = context.checker;
	for (const item of ns.exportedItems) {
		if (item instanceof Class) {
			let symbol = item.symbol;
			//console.log("class full name: "+checker.getFullyQualifiedName(symbol));
			let name = symbol.getName();
			let rustEscapedName = escapeRustName(name);
			let docs = symbol.getDocumentationComment(checker);
			let heritageClauses = item.classDecl.heritageClauses;
			let type = checker.getTypeOfSymbolAtLocation(symbol, item.nameNode);

			for (const docLine of docs) {
				writeln("/// "+docLine);
			}
			writeln("pub trait "+rustEscapedName+":");
			writeln("\t"+BASE_TRAIT_NAME+" +");

			if (heritageClauses !== undefined) {
				heritageClauses.forEach((clause) => {
					clause.types.forEach((baseTypeExpr) => {
						let baseType = checker.getTypeFromTypeNode(baseTypeExpr);
						if (baseType.symbol !== undefined) {
							if (clause.token == ts.SyntaxKind.ExtendsKeyword) {
								writeln("\t"+rustifyFullyQualifiedName(checker.getFullyQualifiedName(baseType.symbol))+" +");
							} else {
								writeln("\t"+rustifyFullyQualifiedName(checker.getFullyQualifiedName(baseType.symbol))+" +");
							}
						}
					});
				});
			}
			writeln("{}");
			writeln("");
			writeln("impl "+rustEscapedName+" for ::stdweb::Value {");
			writeln("}");
			writeln("");
			writeln("impl "+rustEscapedName+" for Box<"+rustEscapedName+"> {");
			writeln("}");
			writeln("");

			//console.log("Symbol "+symbol.getName()+", docs: "+ts.displayPartsToString(symbol.getDocumentationComment(checker))+", type "+checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!)));
			/*function serializeSignature(signature: ts.Signature) {
				return {
					parameters: signature.parameters.map(serializeSymbol),
					returnType: checker.typeToString(signature.getReturnType()),
					documentation: ts.displayPartsToString(signature.getDocumentationComment(checker))
				};
			}*/

			let constructors = type.getConstructSignatures();
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
						newFnName = "__new_"+rustEscapedName + nArgs.toString() + numToAbc(numConstructorsWithNArgsEmitted[nArgs]);
					} else if (constructors.length > 1) {
						newFnName = "__new_"+rustEscapedName + nArgs.toString();
					} else {
						newFnName = "__new_"+rustEscapedName;
					}
					let line = "pub fn "+newFnName+"(";

					let firstParam = true;
					constructor.parameters.forEach((constructorParam) => {
						if (!firstParam) {
							line += ", ";
						}
						firstParam = false;
						//line += escapeRustName(constructorParam.name) + ": " + rustifyType(checker.getDeclaredTypeOfSymbol(constructorParam), context) + ", ";
						line += escapeRustName(constructorParam.name) + ": " + rustifyType(checker.getTypeOfSymbolAtLocation(constructorParam, constructorParam.valueDeclaration!), false, context);
					});

					line += ") -> impl "+rustEscapedName+" {";

					writeln(line);
				}
				{
					let line = "\tjs!(new "+checker.getFullyQualifiedName(symbol) + "(";
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

			if (symbol.members !== undefined) {
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
		} else if (item instanceof Interface) {
			let escapedName = escapeRustName(item.name);
			writeln("pub trait "+escapedName+": "+BASE_TRAIT_NAME+" {");
			writeln("}");
			writeln("");
			writeln("impl "+escapedName+" for ::stdweb::Value {");
			writeln("}");
			writeln("");
		} else if (item instanceof TypeAlias) {
			let escapedName = escapeRustName(item.name);
			writeln("pub trait "+escapedName+": "+BASE_TRAIT_NAME+" {");
			writeln("}");
			writeln("");
			writeln("impl "+escapedName+" for ::stdweb::Value {");
			writeln("}");
			writeln("");
		} else if (item instanceof Namespace) {
			let escapedName = escapeRustName(item.name);
			writeln("pub mod "+escapedName+" {");
			writeln("\tuse super::*;");
			writeln("");
			emitNamespace(item, (s) => writeln("\t"+s), context);
			writeln("}");
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
		this.exportedItems = [];
		this.nameMap = {};
	}

	exportedItems: Item[];
	nameMap: NameMap;

	toStringFull() : string {
		if (this.name == "") {
			return "the root namespace";
		} else if (this.parent === undefined) {
			return "namespace "+this.name;
		} else {
			return this.parent.toStringFull() + "::" + this.name;
		}
	}

	addItem(item: Item) {
		if (!this.nameMap.hasOwnProperty(item.name)) {
			this.exportedItems.push(item);
			this.nameMap[item.name] = [item];
		}
	}
}

function generateDocumentation(fileNames: string[], options: ts.CompilerOptions, outDir:string): void {
    // Build a program using the set of root file names in fileNames
	let program = ts.createProgram(fileNames, options);

    // Get the checker, we will use it to find more about classes
	let checker = program.getTypeChecker();

	let modules = checker.getAmbientModules();

	modules.forEach((m) => {
		console.log(m.name);
		let decls = m.getDeclarations();
		let shouldExport = false;
		if (decls !== undefined) {
			console.log(" - " + decls.map((mDecl) => {
				let fileName = mDecl.getSourceFile().fileName;
				if (fileNames.indexOf(fileName) >= 0) {
					shouldExport = true;
				}
			}));
			if (shouldExport) {
				let exps = checker.getExportsOfModule(m);
				if (exps !== undefined) {
					exps.forEach((e) => {
						console.log(" - exports: "+e.name+": "+checker.getFullyQualifiedName(e));
						let type = checker.getDeclaredTypeOfSymbol(e);
						console.log(" - - type: "+checker.typeToString(type));
						if (type.isClassOrInterface()) {
							let bases = checker.getBaseTypes(type);
							bases.forEach((base) => {
								console.log(" - - - base: "+checker.typeToString(base));
								if (base.symbol !== undefined) {
									console.log(" - - - fqn: "+checker.getFullyQualifiedName(base.symbol));
								}
							});
						}
						/*let members = checker.getRootSymbols(e);
						if (members !== undefined) {
							checker.getBaseTypes
							members.forEach((mem) => {
								console.log(" - - member: "+mem.name+": "+checker.getFullyQualifiedName(mem));
							});
						}*/
					});
				} else {
					console.log("it's undefined");
				}
			}
		}
	})

	return;
	
	console.log("checking...");

	let declaring : boolean | string = true; // if false, not declaring. If true, last keyword was "declare". If string s, last 2 nodes were "declare s".
	
	mkdirp.sync(path.join(outDir, "src"));

	let context = {
		sourceFiles: fileNames,
		checker: checker
	};

    // Visit every sourceFile in the program
    for (const sourceFile of program.getSourceFiles()) {
		if (fileNames.indexOf(sourceFile.fileName) < 0) {
			continue;
		}
		let rootNamespace = new Namespace(undefined, "");
		ts.forEachChild(sourceFile, (n) => visit(n, rootNamespace));

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
		emitNamespace(rootNamespace, (s) => { outStr += s+"\n" }, context);
		
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
    }
	
	console.log("done.");

    return;

    /** visit nodes finding exported classes */
    function visit(node: ts.Node, namespace: Namespace) {
		//console.log("visiting node... "+node.kind.toString());
        // Only consider exported nodes
        /*if (isNodeExported(node)) {
            return;
		}*/
		
		let prevDeclaring = declaring;
		declaring = true;

        if (ts.isClassDeclaration(node) && node.name) {
			let symbol = checker.getSymbolAtLocation(node.name);
			if (symbol !== undefined) {
				let c = new Class(node, symbol, node.name, context);
				namespace.addItem(c);
				let name = symbol.getName();
				let docs = symbol.getDocumentationComment(checker);
				let type = checker.getTypeOfSymbolAtLocation(symbol, node.name);
				let constructors = type.getConstructSignatures();
				//console.log("class "+name);
				symbol.members!.forEach((memSym, key) => {
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
				//console.log(type);
				//console.log("Symbol "++", docs: "++", type "+checker.typeToString();
			}
			// No need to walk any further, class expressions/inner declarations
			// cannot be exported
		}
		else if (ts.isFunctionDeclaration(node) && node.name) {
			let symbol = checker.getSymbolAtLocation(node.name);
			if (symbol !== undefined) {
				let item = new Function(symbol, node.name, context);
				namespace.addItem(item);
			}
		}
		else if (ts.isInterfaceDeclaration(node)) {
			let symbol = checker.getSymbolAtLocation(node.name);
			if (symbol !== undefined) {
				let item = new Interface(symbol, node.name, [], context);
				namespace.addItem(item);
			}
		}
		else if (ts.isTypeAliasDeclaration(node) && node.name) {
			let symbol = checker.getSymbolAtLocation(node.name);
			if (symbol !== undefined) {
				let item = new TypeAlias(symbol, node.name, context);
				namespace.addItem(item);
			}
		}
		else if (ts.isNamespaceExportDeclaration(node)) {
			//console.log("visiting namespace EXPORT "+node.name.getText());
		}
        else if (ts.isModuleDeclaration(node)) {
			// This is a namespace, visit its children
			let nameNode = node.name;
			if (!ts.isStringLiteral(nameNode)) {
				let child = new Namespace(namespace, nameNode.getText());
				ts.forEachChild(node, (n) => visit(n,child));
				namespace.addItem(child);
			}
		}
		else if (ts.isVariableStatement(node)) {
			//console.log("visiting variable statement: ["+node.declarationList.declarations.map((decl) => decl.name.getText()).join(",")+"]");
		}
		else if (ts.isIdentifier(node)) {
			if (prevDeclaring === true) {
				declaring = node.text;
			}
		}
		else if (node.kind == ts.SyntaxKind.DeclareKeyword) {
			declaring = true;
		}
		else if (ts.isModuleBlock(node)) {
			//if (typeof prevDeclaring === "string") {
				//let child = new Namespace(namespace, prevDeclaring);
				node.forEachChild((n) => visit(n,namespace));
				//namespace.addItem(child);
			//}
		}
		else {
			console.log("visiting "+syntaxKindToName(node.kind));
		}
    }

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

let config = readTsConfig("test/pixi.js/tsconfig.json", "test/pixi.js");
if (config) {
	generateDocumentation(["test/pixi.js/index.d.ts"], config.options, "test/pixi.js/output");
}

console.log("ttt");
