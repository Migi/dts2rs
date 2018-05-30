import * as ts from "typescript";

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

type Item = Variable | Class;

class Variable {
	constructor(public name: string) {}
}

class Class {
	constructor(public name: string) {}
}

class Namespace {
	constructor(public parent: Namespace | undefined, public name: string) {
		this.exportedItems = [];
		this.nameToClass = {};
	}

	public exportedItems: Item[];

	public nameToClass: {[name: string]: Class};
}

function generateDocumentation(fileNames: string[], options: ts.CompilerOptions): void {
    // Build a program using the set of root file names in fileNames
    let program = ts.createProgram(fileNames, options);

    // Get the checker, we will use it to find more about classes
	let checker = program.getTypeChecker();
	
	console.log("checking...");

	let num = 0;
	let declaring : boolean | string = false; // if false, not declaring. If true, last keyword was "declare". If string s, last 2 nodes were "declare s". 

    // Visit every sourceFile in the program
    for (const sourceFile of program.getSourceFiles()) {
		if (num++ == 0) {
			continue;
		}
        //if (!sourceFile.isDeclarationFile) {
            // Walk the tree to search for classes
            ts.forEachChild(sourceFile, (n) => visit(n,undefined));
        //}
    }
	
	console.log("done.");

    return;

    /** visit nodes finding exported classes */
    function visit(node: ts.Node, namespace: Namespace | undefined) {
		//console.log("visiting node... "+node.kind.toString());
        // Only consider exported nodes
        /*if (isNodeExported(node)) {
            return;
		}*/
		
		let prevDeclaring = declaring;
		declaring = false;

        if (ts.isClassDeclaration(node) && node.name) {
			//console.log("visiting class "+node.name.getText());
			// This is a top level class, get its symbol
			let symbol = checker.getSymbolAtLocation(node.name);
			// No need to walk any further, class expressions/inner declarations
			// cannot be exported
		}
		else if (ts.isTypeAliasDeclaration(node) && node.name) {
			//console.log("visiting type alias "+node.name.getText());
		}
		else if (ts.isFunctionDeclaration(node) && node.name) {
			//console.log("visiting function "+node.name.getText());
		}
		else if (ts.isNamespaceExportDeclaration(node)) {
			//console.log("visiting namespace EXPORT "+node.name.getText());
		}
        else if (ts.isModuleDeclaration(node)) {
            // This is a namespace, visit its children
			let child = new Namespace(namespace, node.name.getText());
            ts.forEachChild(node, (n) => visit(n,child));
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
			if (typeof prevDeclaring === "string") {
				console.log("visiting module block "+prevDeclaring);
				let child = new Namespace(namespace, prevDeclaring);
				node.forEachChild((n) => visit(n,child));
			}
		}
		else if (ts.isInterfaceDeclaration(node)) {
			//console.log("visiting interface "+node.name.getText());
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
	generateDocumentation(["test/pixi.js/index.d.ts"], config.options);
}

console.log("ttt");
