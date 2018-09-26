import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as mkdirp from "mkdirp";
import * as collect from "./collect";
import * as stdweb_emit from "./stdweb_emit";

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

function dts2rs(dir: string, outDir:string, packageName:string): void {
	let program = collect.collectProgramInDir(dir);

	console.log("done collecting");

	let libRsStr = "";
	stdweb_emit.emitLibRs(s => { libRsStr += s+"\n"; console.log(s); }, program);
	let cargoTomlStr = stdweb_emit.emitCargoToml(packageName);
	
	mkdirp.sync(path.join(outDir, "src"));
	
	fs.writeFile(path.join(outDir, "Cargo.toml"), cargoTomlStr, undefined, (err) => {
		if (err) {
			console.error("Error writing Cargo.toml: "+err.message);
		}
	});

	fs.writeFile(path.join(outDir, "src", "lib.rs"), libRsStr, undefined, (err) => {
		if (err) {
			console.error("Error writing lib.rs: "+err.message);
		}
	});
}

{
	let testDir = "test/pixi.js";
	let outDir = testDir+"/output";
	let packageName = "pixi-js";
	dts2rs(testDir, outDir, packageName);
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
