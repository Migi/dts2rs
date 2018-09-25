import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as mkdirp from "mkdirp";
import * as collect from "./collect";

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

function dts2rs(fileNames: string[], options: ts.CompilerOptions, outDir:string, packageName:string): void {
	let program = ts.createProgram(fileNames, options);

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
	writeln("impl<T: ::stdweb::JsSerialize> ::stdweb::JsSerialize for Any<T> {");
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
	writeln("pub struct FnHandle<Args, Out> {");
	writeln("\t__js_ref: ::stdweb::Reference,");
	writeln("\tphantom_args: ::std::marker::PhantomData<Args>,");
	writeln("\tphantom_out: ::std::marker::PhantomData<Out>,");
	writeln("}");
	writeln("");
	writeln("impl<Args: ::stdweb::JsSerialize, Out: ::stdweb::private::JsSerializeOwned> FnHandle<Args, Out> {");
	writeln("\tpub fn from_fn(f: impl Fn(Args) -> Out) -> Self {");
	writeln("\t\tSelf {");
	writeln("\t\t\t__js_ref: __js_value_into_reference(js!(return @{f};), \"function (from a Rust Fn)\"),");
	writeln("\t\t\tphantom_args: ::std::marker::PhantomData,");
	writeln("\t\t\tphantom_out: ::std::marker::PhantomData,");
	writeln("\t\t}");
	writeln("\t}");
	writeln("");
	writeln("\tpub fn leak(self) {}");
	writeln("}");
	writeln("");
	writeln("impl<Args, Out> Drop for FnHandle<Args, Out> {");
	writeln("\tfn drop(&mut self) {");
	writeln("\t\tjs!(@(no_return) @{&self.__js_ref}.drop());");
	writeln("\t}");
	writeln("}");
	writeln("");
	writeln("#[doc(hidden)]");
	writeln("impl<Args, Out> ::stdweb::JsSerialize for FnHandle<Args, Out> {");
	writeln("\t#[doc(hidden)]");
	writeln("\tfn _into_js< 'a >( &'a self ) -> ::stdweb::private::SerializedValue< 'a > {");
	writeln("\t\tself.__js_ref._into_js()");
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
	writeln("impl<Args, O> __JsCallable for FnHandle<Args, O> {}");
	writeln("");

	context.closures.forEach((f) => {
		let fStructName = f.getRustTypeName("JsFn");
		let fTraitName = f.getRustTypeName("JsCallable");
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
		let boundsStr = "";
		let paramsStr = "";
		for (let i = 0; i < f.args.length; i++) {
			let argStr = f.args[i].type.inArgPosName(context.rootNameSpace);
			if (argStr.substr(0,5) == "impl ") {
				let bound = argStr.substr(5);
				if (boundsStr != "") {
					boundsStr += ", ";
				}
				boundsStr += "T"+i+": "+bound;

				if (paramsStr != "") {
					paramsStr += ", ";
				}
				paramsStr += "T"+i;
			} else {
				if (paramsStr != "") {
					paramsStr += ", ";
				}
				paramsStr += argStr;
			}
		}
		writeln("impl<"+(boundsStr == "" ? "" : boundsStr + ", ")+"O> "+fTraitName+" for FnHandle<("+paramsStr+"), O> {}");
		writeln("");
	});

	/*outStr += "pub trait "+CLASS_BASE_TRAITS+" : ::stdweb::JsSerialize + ::stdweb::JsSerializeOwned {\n";
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
	writeln("\tpub use FnHandle;");
	context.rootNameSpace.emitPrelude(indentAdder(writeln), context);
	context.closures.forEach((f) => {
		let fTraitName = f.getRustTypeName("JsCallable");
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
