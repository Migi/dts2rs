import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as mkdirp from "mkdirp";

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
	constructor(public symbol: ts.Symbol, public nameNode: ts.Node) {
		this.name = symbol.getName();
	}
	name: string;
}

class Class extends BaseItem {
	constructor(public classDecl: ts.ClassDeclaration, symbol: ts.Symbol, nameNode: ts.Node) {
		super(symbol, nameNode);
	}
}

class Function extends BaseItem {
	constructor(symbol: ts.Symbol, nameNode: ts.Node) {
		super(symbol, nameNode);
	}
}

class Interface extends BaseItem {
	constructor(symbol: ts.Symbol, nameNode: ts.Node) {
		super(symbol, nameNode);
	}
}

const BASE_TRAIT_NAME = "__WrapsJsRef";

function getSubClassOfTraitName(className:string) : string {
	return "__SubClassOf_"+className;
}

function rustifyFullyQualifiedName(fullyQualifiedName: string) : string {
	return fullyQualifiedName.replace(/\./g, "::");
}

function rustifyAndMapToTraitFullyQualifiedName(fullyQualifiedName: string) : string {
	let arr = fullyQualifiedName.split('.');
	if (arr.length == 0) {
		console.error("Fully qualified name \""+fullyQualifiedName+"\" is not valid!");
		throw "exiting...";
	}
	arr[arr.length-1] = getSubClassOfTraitName(arr[arr.length-1]);
	return arr.join("::");
}

function rustifyType(t:ts.Type) : string | undefined {
	let f = t.flags;
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

function emitCargoToml() : string {
	return ""+
	"[package]\n" +
	"name = \"todomvc\"\n" +
	"version = \"1.0.0\"\n" +
	"authors = [\"dts2rs\"]\n" +
	"\n" + 
	"[dependencies]\n" +
	"stdweb = \"0.4\"\n";
}

function emitNamespace(ns:Namespace, checker: ts.TypeChecker, writeln: (s:string) => void) {
	for (const item of ns.exportedItems) {
		if (item instanceof Class) {
			let symbol = item.symbol;
			//console.log("class full name: "+checker.getFullyQualifiedName(symbol));
			let name = symbol.getName();
			let docs = symbol.getDocumentationComment(checker);
			let heritageClauses = item.classDecl.heritageClauses;
			let type = checker.getTypeOfSymbolAtLocation(symbol, item.nameNode);

			for (const docLine of docs) {
				writeln("/// "+docLine);
			}
			writeln("#[derive(Clone,Debug)]");
			writeln("pub struct "+name+"(::stdweb::Reference);");
			writeln("");
			writeln("pub trait "+getSubClassOfTraitName(name)+":");
			writeln("\t"+BASE_TRAIT_NAME+" +");

			if (heritageClauses !== undefined) {
				heritageClauses.forEach((clause) => {
					clause.types.forEach((baseTypeExpr) => {
						let baseType = checker.getTypeFromTypeNode(baseTypeExpr);
						if (baseType.symbol !== undefined) {
							if (clause.token == ts.SyntaxKind.ExtendsKeyword) {
								writeln("\t"+rustifyAndMapToTraitFullyQualifiedName(checker.getFullyQualifiedName(baseType.symbol))+" +");
							} else {
								writeln("\t"+rustifyFullyQualifiedName(checker.getFullyQualifiedName(baseType.symbol))+" +");
							}
						}
					});
				});
			}
			writeln("{");
			let constructors = type.getConstructSignatures();
			writeln("}");
			writeln("");

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
			writeln("pub trait "+item.name+" {");
			writeln("}");
			writeln("");
		} else if (item instanceof Namespace) {
			writeln("pub mod "+item.name+" {");
			writeln("\tuse super::*;");
			writeln("");
			emitNamespace(item, checker, (s) => writeln("\t"+s));
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
	
	console.log("checking...");

	let declaring : boolean | string = true; // if false, not declaring. If true, last keyword was "declare". If string s, last 2 nodes were "declare s".
	
	mkdirp.sync(path.join(outDir, "src"));

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
		outStr += "pub trait "+BASE_TRAIT_NAME+" {\n";
		outStr += "\tfn __get_jsref() -> ::stdweb::Reference;\n";
		outStr += "}\n";
		outStr += "\n";
		outStr += "#[derive(Clone,Debug)]\n";
		outStr += "pub struct Any(::stdweb::Value);\n";
		outStr += "\n";
		emitNamespace(rootNamespace, checker, (s) => { outStr += s+"\n" });
		
		fs.writeFile(path.join(outDir, "Cargo.toml"), emitCargoToml(), undefined, (err) => {
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
				let c = new Class(node, symbol, node.name);
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
		else if (ts.isTypeAliasDeclaration(node) && node.name) {
			//console.log("visiting type alias "+node.name.getText());
		}
		else if (ts.isFunctionDeclaration(node) && node.name) {
			let symbol = checker.getSymbolAtLocation(node.name);
			if (symbol !== undefined) {
				let item = new Function(symbol, node.name);
				namespace.addItem(item);
			}
		}
		else if (ts.isInterfaceDeclaration(node)) {
			let symbol = checker.getSymbolAtLocation(node.name);
			if (symbol !== undefined) {
				let item = new Interface(symbol, node.name);
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
