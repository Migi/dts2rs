/// This file contains all functions for converting typescript types into the types in data.ts
/// This is the only file that talks to typescript

import * as ts from "typescript";
import * as data from "./data";
import * as util from "./util";

export function collectProgramInDir(dir: string): data.Program {
	let tsconfigFile = dir+"/tsconfig.json";
	let dtsFile = dir+"/index.d.ts";
	let config = readTsConfig(tsconfigFile, dir);
	return collectProgram([dtsFile], config.options);
}

export function readTsConfig(tsConfigJsonFileName:string, basePath:string) : ts.ParsedCommandLine {
	let diagnosticsHost : ts.FormatDiagnosticsHost = {
		getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
		getNewLine: () => ts.sys.newLine,
		getCanonicalFileName: (filename) => filename
	};

	let configJson = ts.readConfigFile(tsConfigJsonFileName, ts.sys.readFile);
	if (configJson.error !== undefined) {
		console.error("Failed to read tsconfig.json file \""+tsConfigJsonFileName+"\"!");
		console.error(ts.formatDiagnostic(configJson.error, diagnosticsHost));
		throw "ConfigParseError";
	}
	let config = ts.parseJsonConfigFileContent(configJson, ts.sys, basePath);
	return config;
}

export function collectProgram(fileNames: string[], options: ts.CompilerOptions): data.Program {
	let program = ts.createProgram(fileNames, options);

	let checker = program.getTypeChecker();

	let collector = new Collector(fileNames, checker, {});

	// TODO: ambientModules is not actually used. Remove?
	let ambientModules : ts.Symbol[] = [];
	checker.getAmbientModules().forEach((m) => {
		let shouldExport = false;
		util.forEach(m.getDeclarations(), (mDecl) => {
			let fileName = mDecl.getSourceFile().fileName;
			if (fileNames.indexOf(fileName) >= 0) {
				shouldExport = true;
			}
		});
		if (shouldExport) {
			util.forEach(checker.getExportsOfModule(m), (e) => {
				collector.collectSymbol(e);
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
				collector.collectSymbol(sfExp);
				hasTopLevelExports = true;
			});
		}
	}

	return {
		rootNameSpace: collector.rootNamespace,
		closures: collector.closures
	};
}

function makeTypeFromOnlyFlags(type:ts.Type) : data.Type {
	let f = type.flags;
	if (f & ts.TypeFlags.Any) {
		return data.Any;
	} else if (f & ts.TypeFlags.String) {
		return data.String;
	} else if (f & ts.TypeFlags.Number) {
		return data.Number;
	} else if (f & ts.TypeFlags.Boolean) {
		return data.Bool;
	} else if (f & ts.TypeFlags.Enum) {
		return data.Number;
	} else if (f & ts.TypeFlags.StringLiteral) {
		return data.String;
	} else if (f & ts.TypeFlags.NumberLiteral) {
		return data.Number;
	} else if (f & ts.TypeFlags.BooleanLiteral) {
		return data.Bool;
	} else if (f & ts.TypeFlags.EnumLiteral) {
		return data.Number;
	} else if (f & ts.TypeFlags.ESSymbol) {
		return data.Symbol;
	} else if (f & ts.TypeFlags.UniqueESSymbol) {
		return data.Symbol;
	} else if (f & ts.TypeFlags.Void) {
		return data.Unit;
	} else if (f & ts.TypeFlags.Undefined) {
		return data.Undefined;
	} else if (f & ts.TypeFlags.Null) {
		return data.Null;
	} else if (f & ts.TypeFlags.Never) {
		return data.Never;
	} else if (f & ts.TypeFlags.TypeParameter) {
		return data.Unknown;
	} else if (f & ts.TypeFlags.Object) {
		return data.Any;
	} else if (f & ts.TypeFlags.Union) {
		return data.Unknown;
	} else if (f & ts.TypeFlags.Intersection) {
		return data.Unknown;
	} else if (f & ts.TypeFlags.Index) {
		return data.Unknown;
	} else if (f & ts.TypeFlags.IndexedAccess) {
		return data.Unknown;
	} else if (f & ts.TypeFlags.Conditional) {
		return data.Unknown;
	} else if (f & ts.TypeFlags.Substitution) {
		return data.Unknown;
	} else if (f & ts.TypeFlags.NonPrimitive) {
		return data.Unknown;
	} else {
		return data.Unknown;
	}
}

class Collector {
	collectedTypes : Map<ts.Type, data.Type>;
	collectedSymbols : Map<ts.Symbol, data.Type>;
	rootNamespace : data.Namespace;
	closures: data.FunctionType[];

	constructor(public sourceFiles: string[], public checker: ts.TypeChecker, public existingTypeFqnMap : {[key:string]: data.Type}) {
		this.collectedTypes = new Map<ts.Type, data.Type>();
		this.collectedSymbols = new Map<ts.Symbol, data.Type>();
		this.rootNamespace = new data.Namespace(undefined, "");
		this.closures = [];
	}

	getSymbolDocs(symbol: ts.Symbol) : string {
		let docs = symbol.getDocumentationComment(this.checker);
		return ts.displayPartsToString(docs);
	}

	getSignatureDocs(symbol: ts.Signature) : string {
		let docs = symbol.getDocumentationComment(this.checker);
		return ts.displayPartsToString(docs);
	}

	collectType(type:ts.Type) : data.Type {
		let cached = this.collectedTypes.get(type);
		if (cached !== undefined) {
			return cached;
		} else {
			let result = this.collectTypeWithoutStoring(type);
			this.collectedTypes.set(type, result);
			return result;
		}
	}

	private collectTypeWithoutStoring(type: ts.Type) : data.Type {
		if (type.isUnion()) {
			let types = type.types.map((t) => this.collectType(t));
			let type0 = types[0];
			let allMatch = true;
			for (let i = 1; i < types.length; i++) {
				if (!data.typesAreSame(type0, types[i])) {
					allMatch = false;
					break;
				}
			}
			if (allMatch) {
				return type0;
			} else {
				return data.Unknown;
			}
		}

		let callSigs = type.getCallSignatures();
		if (callSigs.length == 1) {
			let sig = this.collectSignature(callSigs[0]);
			return this.collectClosure(sig);
		}

		let symbol = undefined;
		if (type.aliasSymbol !== undefined) {
			symbol = type.aliasSymbol;
		} else if (type.symbol !== undefined) {
			symbol = type.symbol;
		}
		if (symbol === undefined) {
			return makeTypeFromOnlyFlags(type);
		} else {
			return this.collectSymbolAndTypeWithoutStoring(symbol, type);
		}
	}

	collectSymbol(symbol: ts.Symbol): data.Type {
		let cached = this.collectedSymbols.get(symbol);
		if (cached !== undefined) {
			return cached;
		} else {
			let type = this.checker.getDeclaredTypeOfSymbol(symbol);
			let result = this.collectSymbolAndTypeWithoutStoring(symbol, type);
			this.collectedSymbols.set(symbol, result);
			return result;
		}
	}

	collectSymbolAndTypeWithoutStoring(symbol: ts.Symbol, type: ts.Type) : data.Type {
		let result = this.collectSymbolAndTypeWithoutOptionalOrStoring(symbol, type);
		let isOptional = symbol.flags & ts.SymbolFlags.Optional;
		if (isOptional) {
			result = new data.Optional(result);
		}
		return result;
	}
	
	collectSymbolAndTypeWithoutOptionalOrStoring(symbol: ts.Symbol, type: ts.Type) : data.Type {
		let callSigs = type.getCallSignatures();
		if (callSigs.length == 1) {
			let sig = this.collectSignature(callSigs[0]);
			return this.collectClosure(sig);
		}

		let shouldOutputType = false;
		let decls = symbol.getDeclarations();
		if (decls !== undefined) {
			for (const decl of decls) {
				let fileName = decl.getSourceFile().fileName;
				if (this.sourceFiles.indexOf(fileName) >= 0) {
					shouldOutputType = true;
				}
			}
		}

		if (shouldOutputType) {
			if (type.isClass()) {
				return this.collectClass(symbol, type);
			} else if (type.isClassOrInterface()) {
				return this.collectInterface(symbol, type);
			} else if (symbol.flags & ts.SymbolFlags.Function) {
				return this.collectFunction(symbol, type);
			}
		} else {
			let qualifiedName = this.checker.getFullyQualifiedName(symbol);
			if (this.existingTypeFqnMap.hasOwnProperty(qualifiedName)) {
				return this.existingTypeFqnMap[qualifiedName];
			}
		}

		return makeTypeFromOnlyFlags(type);
	}

	collectSymbolEnclosingNamespaces(symbol:ts.Symbol) : [data.Namespace,string] {
		let parsedFqn = parseFQN(this.checker.getFullyQualifiedName(symbol));
		let curNS = this.rootNamespace;
		for (let i = 0; i < parsedFqn.length-1; i++) {
			curNS = curNS.getOrCreateSubNamespace(parsedFqn[i]);
		}
		return [curNS, parsedFqn[parsedFqn.length-1]];
	}

	collectSignature(signature: ts.Signature) : data.FunctionType {
		let retType = this.collectType(signature.getReturnType());
		let args : data.Variable[] = [];
		signature.parameters.forEach((param) => {
			let type = this.checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration!);
			let rustType = this.collectType(type);
			let isOptional = false;
			let hasDotDotDot = false;
			util.forEach(param.declarations, (paramDecl) => {
				if (ts.isParameter(paramDecl)) {
					if (this.checker.isOptionalParameter(paramDecl)) {
						isOptional = true;
					}
					if (paramDecl.dotDotDotToken !== undefined) {
						hasDotDotDot = true;
					}
				}
			});
			if (isOptional) {
				rustType = new data.Optional(rustType);
			}
			if (!hasDotDotDot) {
				args.push(new data.Variable(param.name, this.checker.typeToString(type), util.escapeRustName(param.name), rustType, isOptional));
			}
		});
		return new data.FunctionType(args, retType, this.checker.typeToString(signature.getReturnType()));
	}

	collectClosure(signature: data.FunctionType) : data.FunctionType {
		let existing = this.closures.find((sig) => { return sig.isSameAs(signature) });

		if (existing !== undefined) {
			return existing;
		} else {
			this.closures.push(signature);
			return signature;
		}
	}

	collectFunction(symbol:ts.Symbol, type:ts.Type) : data.Type {
		let [ns, name] = this.collectSymbolEnclosingNamespaces(symbol);

		let docs = this.getSymbolDocs(symbol);

		let result : data.NamedFunction[] = [];

		util.forEach(symbol.declarations, (decl) => {
			let functionType = this.checker.getTypeOfSymbolAtLocation(symbol, decl);
			util.forEach(functionType.getCallSignatures(), (callSig) => {
				let f = new data.NamedFunction(util.escapeRustName(symbol.name), symbol.name, this.collectSignature(callSig), docs);
				ns.addStaticFunction(f);
				result.push(f);
			});
		});

		if (result.length > 0) {
			return result[0].signature;
		} else {
			return data.Unknown;
		}
	}

	collectMembers(obj: data.ClassOrInterface, symbol: ts.Symbol, type: ts.Type) {
		let members = type.getProperties();
		util.forEach(members, (memSym) => {
			let isPrivate = false;
			if (memSym.declarations !== undefined && memSym.declarations.length > 0) {
				let mods = memSym.declarations[0].modifiers;
				if (mods !== undefined) {
					isPrivate = mods.some((v) => v.kind == ts.SyntaxKind.ProtectedKeyword || v.kind == ts.SyntaxKind.PrivateKeyword);
				}
			}
			if (!isPrivate) {
				let memType = this.checker.getTypeOfSymbolAtLocation(memSym, memSym.valueDeclaration!);
				memType.getCallSignatures().forEach((callSig) => {
					obj.addMethod(new data.NamedFunction(
						util.escapeRustName(memSym.name),
						memSym.name,
						this.collectSignature(callSig),
						this.getSignatureDocs(callSig)
					));
				});
				if (memSym.flags & ts.SymbolFlags.Property) {
					let memRustType = this.collectType(memType);
					let isOptional = ((memSym.flags & ts.SymbolFlags.Optional) != 0);
					if (isOptional) {
						memRustType = new data.Optional(memRustType);
					}
					obj.properties.push(new data.Variable(memSym.name, this.checker.typeToString(memType), util.escapeRustName(memSym.name), memRustType, isOptional));
				}
			}
		});
	}

	collectClass(symbol:ts.Symbol, type:ts.InterfaceType) : data.ClassType {
		console.assert(type.isClass());

		let [ns, name] = this.collectSymbolEnclosingNamespaces(symbol);

		if (ns.classes.hasOwnProperty(name)) {
			return ns.classes[name];
		}

		let result = ns.getOrCreateClass(symbol.name, this.getSymbolDocs(symbol));

		let bases = this.checker.getBaseTypes(type);
		bases.forEach((base) => {
			let baseSym = base.symbol;
			if (baseSym !== undefined) {
				if (base.isClass()) {
					if (result.superClass === undefined) {
						result.superClass = this.collectClass(baseSym, base);
					}
				} else if (base.isClassOrInterface()) {
					let i = this.collectInterface(baseSym, base);
					result.pushDirectImpl(i);
				}
			}
		});

		// the above code doesn't find the classes interfaces or constructors, so do it manually
		util.forEach(symbol.declarations, (decl) => {
			if (!ts.isClassDeclaration(decl)) {
				return;
			}
			if (symbol.name == "Sprite") {
				decl.members.forEach((mem) => {
					let isStaticMethod = false;
					if (mem.kind == ts.SyntaxKind.MethodDeclaration) {
						util.forEach(mem.modifiers, (modifier) => {
							if (modifier.kind == ts.SyntaxKind.StaticKeyword) {
								isStaticMethod = true;
							}
						});
						if (isStaticMethod) {
							let memType = this.checker.getTypeAtLocation(mem);
							if (memType.symbol) {
								let memName = memType.symbol.name;
								let memRustName = util.escapeRustName(memName);
								util.forEach(memType.getCallSignatures(), (callSig) => {
									let sig = this.collectSignature(callSig);
									result.addStaticMethod(new data.NamedFunction(memRustName, memName, sig, this.getSignatureDocs(callSig)));
								});
							}
						}
					}
				});
			}
			util.forEach(decl.heritageClauses, (her) => {
				if (her.token == ts.SyntaxKind.ImplementsKeyword) {
					util.forEach(her.types, (type) => {
						let implType = this.checker.getTypeAtLocation(type);
						let implSym = implType.symbol;
						if (implSym !== undefined) {
							if (implType.isClassOrInterface()) {
								let i = this.collectInterface(implSym, implType);
								result.pushDirectImpl(i);
							}
						}
					});
				}
			});
			let declName = decl.name;
			if (declName !== undefined) {
				let declNameType = this.checker.getTypeOfSymbolAtLocation(symbol, declName);
				let constructors = declNameType.getConstructSignatures();
				constructors.forEach((constructor) => {
					result.addConstructor(new data.NamedFunction("new", "new", this.collectSignature(constructor), this.getSignatureDocs(constructor)));
				});
			}
		});

		this.collectMembers(result, symbol, type);

		return result;
	}

	collectInterface(symbol:ts.Symbol, type:ts.InterfaceType) : data.InterfaceType {
		let [ns, name] = this.collectSymbolEnclosingNamespaces(symbol);

		if (ns.interfaces.hasOwnProperty(name)) {
			return ns.interfaces[name];
		}

		let result = ns.getOrCreateInterface(symbol.name, this.getSymbolDocs(symbol));

		let bases = this.checker.getBaseTypes(type);
		bases.forEach((base) => {
			let baseSym = base.symbol;
			if (baseSym !== undefined) {
				if (base.isClassOrInterface()) {
					let i = this.collectInterface(baseSym, base);
					result.pushDirectImpl(i);
				}
			}
		});

		this.collectMembers(result, symbol, type);

		return result;
	}
}

function parseFQN(fqn:string) : string[] {
	return fqn.split(".").map((part) => {
		if (part.charCodeAt(0) == 34 /* " */ && part.charCodeAt(part.length-1) == 34 /* " */) {
			return part.substr(1, part.length-2);
		} else {
			return part;
		}
	}).map(util.escapeRustName);
}
