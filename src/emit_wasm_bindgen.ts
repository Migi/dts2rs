/// This file emits .rs code to be used with wasm_bindgen

import * as data from "./data";
import * as util from "./util";
import * as codegen from "./codegen";

enum FunctionKind {
	METHOD,
	CONSTRUCTOR,
	FREE_FUNCTION,
	NAMESPACED_FUNCTION,
	STATIC_METHOD
}

function typeInArgPos(type: data.Type, curNS: data.Namespace) : string {
	switch (type.kind) {
		case "any": return "&::wasm_bindgen::JsValue";
		case "unknown": return "&::wasm_bindgen::JsValue";
		case "number": return "f64";
		case "string": return "&::js_sys::JsString";
		case "bool": return "bool";
		case "symbol": return "&::js_sys::Symbol";
		case "undefined": return "&::wasm_bindgen::JsValue"; // wasm_bindgen has no type representing undefined
		case "null": return "&::wasm_bindgen::JsValue"; // wasm_bindgen has no type representing null
		case "void": throw "ERROR: can't have void as a function argument!";
		case "never": throw "ERROR: can't have a never type as a function argument!";
		case "optional": {
			if (type.subtype.canBeUndefined) {
				return typeInArgPos(type.subtype, curNS);
			} else {
				return "Option<"+typeInArgPos(type.subtype, curNS)+">";
			}
		}
		case "class": return "&"+curNS.getRustPathTo(type.namespace, type.rustName);
		case "interface": return "&"+curNS.getRustPathTo(type.namespace, type.rustName);
		case "function": return "&::js_sys::Function";
		default: {
			let exhaustive : never = type;
			return exhaustive;
		}
	}
}

function typeInReturnPos(type: data.Type, curNS: data.Namespace) : string {
	switch (type.kind) {
		case "any": return "::wasm_bindgen::JsValue";
		case "unknown": return "::wasm_bindgen::JsValue";
		case "number": return "f64";
		case "string": return "::js_sys::JsString";
		case "bool": return "bool";
		case "symbol": return "::js_sys::Symbol";
		case "undefined": return "()"; // wasm_bindgen has no type representing undefined
		case "null": return "()"; // wasm_bindgen has no type representing null
		case "void": return "()";
		case "never": throw "ERROR: can't have a never type as a function argument!";
		case "optional": {
			if (type.subtype.canBeUndefined) {
				return typeInReturnPos(type.subtype, curNS);
			} else {
				return "Option<"+typeInReturnPos(type.subtype, curNS)+">";
			}
		}
		case "class": return curNS.getRustPathTo(type.namespace, type.rustName);
		case "interface": return curNS.getRustPathTo(type.namespace, type.rustName);
		case "function": return "::js_sys::Function";
		default: {
			let exhaustive : never = type;
			return exhaustive;
		}
	}
}

function argToRefJsValue(type: data.Type, value: string, curNS: data.Namespace) : string {
	switch (type.kind) {
		case "any": return value;
		case "unknown": return value;
		case "number": return "&::wasm_bindgen::JsValue::from_f64("+value+")";
		case "string": return "&"+value+".into()";
		case "bool": return "&::wasm_bindgen::JsValue::from_bool("+value+")";
		case "symbol": return "&"+value+".into()";
		case "undefined": return "&::wasm_bindgen::JsValue::undefined()";
		case "null": return "&::wasm_bindgen::JsValue::null()";
		case "void": throw "ERROR: can't construct a void!";
		case "never": throw "ERROR: can't construct a never!";
		case "optional": {
			if (type.subtype.canBeUndefined) {
				return argToRefJsValue(type.subtype, value, curNS);
			} else {
				return "(match "+value+" { Ok(val) => { "+argToRefJsValue(type.subtype, "val", curNS)+" }, Err(_) => ::wasm_bindgen::JsValue::undefined())";
			}
		}
		case "class": return "&"+value+".into()";
		case "interface": return "&"+value+".into()";
		case "function": return "&"+value+".into()";
		default: {
			let exhaustive : never = type;
			return exhaustive;
		}
	}
}

function emitSpecifiers(cg: codegen.CodeGen, f: (add: (s:string) => void) => void) : void {
	let specifiers = "";
	let add = (s:string) => {
		if (specifiers != "") {
			specifiers = specifiers + ", " + s;
		} else {
			specifiers = s;
		}
	};
	f(add);
	if (specifiers != "") {
		cg.writeln("#[wasm_bindgen("+specifiers+")]");
	} else {
		cg.writeln("#[wasm_bindgen]");
	}
}

function emitDocs(cg: codegen.CodeGen, docs: string) : void {
	if (docs == "") {
		return;
	}
	let lines = docs.split("\n");
	for (const docLine of lines) {
		cg.writeln("/// "+docLine);
	}
}

function emitClass(cg: codegen.CodeGen, theClass: data.ClassType) : void {
	cg.writeln("#[wasm_bindgen]");
	cg.scope("extern {", (cg) => {
		emitDocs(cg, theClass.docs);

		emitSpecifiers(cg, (addSpecifier) => {
			if (theClass.rustName != theClass.jsName) {
				addSpecifier("js_name = "+theClass.jsName);
			}
			theClass.forEachSuperClass((c) => {
				addSpecifier("extends = "+theClass.namespace.getRustPathTo(c.namespace, c.rustName));
			});
			theClass.forEachSuperImpl((i) => {
				addSpecifier("extends = "+theClass.namespace.getRustPathTo(i.namespace, i.rustName));
			});
		});
		cg.writeln("pub type "+theClass.rustName+";");
		cg.writeln();

		theClass.methods.forEachResolvedFunction((method) => {
			emitFunction(cg, method, FunctionKind.METHOD, theClass.namespace, theClass);
		});
		let methodNameMap = theClass.methods.getResolvedNameMap();
		theClass.properties.forEach((prop) => {
			if (!methodNameMap.has(prop.rustName)) {
				emitSpecifiers(cg, (addSpecifier) => {
					addSpecifier("method");
					if (prop.rustName == prop.jsName) {
						addSpecifier("getter");
					} else {
						addSpecifier("getter = "+prop.jsName);
					}
					addSpecifier("structural");
					if (theClass.rustName != theClass.jsName) {
						addSpecifier("js_class = "+theClass.jsName);
					}
				});
				cg.writeln("pub fn "+prop.rustName+"(this: &"+theClass.rustName+") -> "+typeInReturnPos(prop.type, theClass.namespace)+";");
				cg.writeln();
			}
			if (!methodNameMap.has("set_"+prop.rustName)) {
				emitSpecifiers(cg, (addSpecifier) => {
					addSpecifier("method");
					if (prop.rustName == prop.jsName) {
						addSpecifier("setter");
					} else {
						addSpecifier("setter = "+prop.jsName);
					}
					addSpecifier("structural");
					if (theClass.rustName != theClass.jsName) {
						addSpecifier("js_class = "+theClass.jsName);
					}
				});
				cg.writeln("pub fn set_"+prop.rustName+"(this: &"+theClass.rustName+", val: "+typeInReturnPos(prop.type, theClass.namespace)+");");
				cg.writeln();
			}
		});

		theClass.constructors.forEachResolvedFunction((constructor) => {
			emitFunction(cg, constructor, FunctionKind.CONSTRUCTOR, theClass.namespace, theClass);
		});
		theClass.staticMethods.forEachResolvedFunction((staticMethod) => {
			emitFunction(cg, staticMethod, FunctionKind.STATIC_METHOD, theClass.namespace, theClass);
		});
	});
	cg.writeln();
		
	cg.scope("impl ::std::ops::Deref for "+theClass.rustName+" {", (cg) => {
		if (theClass.superClass === undefined) {
			cg.writeln("type Target = ::wasm_bindgen::JsValue;");
			cg.writeln();
			cg.scope("fn deref(&self) -> &Self::Target {", (cg) => {
				cg.writeln("self.as_ref()");
			});
		} else {
			cg.writeln("type Target = "+theClass.namespace.getRustPathTo(theClass.superClass.namespace, theClass.superClass.rustName)+";");
			cg.writeln();
			cg.scope("fn deref(&self) -> &Self::Target {", (cg) => {
				cg.writeln("::wasm_bindgen::JsCast::unchecked_from_js_ref(self.as_ref())");
			});
		}
	});
	cg.writeln();
}

function emitInterface(cg: codegen.CodeGen, theInterface: data.InterfaceType) : void {
	cg.writeln("#[wasm_bindgen]");
	cg.scope("extern {", (cg) => {
		emitDocs(cg, theInterface.docs);
		emitSpecifiers(cg, (addSpecifier) => {
			theInterface.forEachSuperImpl((i) => {
				addSpecifier("extends = "+theInterface.namespace.getRustPathTo(i.namespace, i.rustName));
			});
		});
		cg.writeln("pub type "+theInterface.rustName+";");
		cg.writeln();

		theInterface.methods.forEachResolvedFunction((method) => {
			emitFunction(cg, method, FunctionKind.METHOD, theInterface.namespace, theInterface);
		});
		let methodNameMap = theInterface.methods.getResolvedNameMap();
		theInterface.properties.forEach((prop) => {
			if (!methodNameMap.has(prop.rustName)) {
				emitSpecifiers(cg, (addSpecifier) => {
					addSpecifier("method");
					if (prop.rustName == prop.jsName) {
						addSpecifier("getter");
					} else {
						addSpecifier("getter = "+prop.jsName);
					}
					addSpecifier("structural");
					if (theInterface.rustName != theInterface.jsName) {
						addSpecifier("js_class = "+theInterface.jsName);
					}
				});
				cg.writeln("pub fn "+prop.rustName+"(this: &"+theInterface.rustName+") -> "+typeInReturnPos(prop.type, theInterface.namespace)+";");
				cg.writeln();
			}
			if (!methodNameMap.has("set_"+prop.rustName)) {
				emitSpecifiers(cg, (addSpecifier) => {
					addSpecifier("method");
					if (prop.rustName == prop.jsName) {
						addSpecifier("setter");
					} else {
						addSpecifier("setter = "+prop.jsName);
					}
					addSpecifier("structural");
					if (theInterface.rustName != theInterface.jsName) {
						addSpecifier("js_class = "+theInterface.jsName);
					}
				});
				cg.writeln("pub fn set_"+prop.rustName+"(this: &"+theInterface.rustName+", val: "+typeInReturnPos(prop.type, theInterface.namespace)+");");
				cg.writeln();
			}
		});
	});
	cg.writeln();
		
	if (theInterface.directImpls.length <= 1) {
		cg.scope("impl ::std::ops::Deref for "+theInterface.rustName+" {", (cg) => {
			if (theInterface.directImpls.length == 0) {
				cg.writeln("type Target = ::wasm_bindgen::JsValue;");
				cg.writeln();
				cg.scope("fn deref(&self) -> &Self::Target {", (cg) => {
					cg.writeln("self.as_ref()");
				});
			} else {
				let theSuperInterface = theInterface.directImpls[0];
				cg.writeln("type Target = "+theInterface.namespace.getRustPathTo(theSuperInterface.namespace, theSuperInterface.rustName)+";");
				cg.writeln();
				cg.scope("fn deref(&self) -> &Self::Target {", (cg) => {
					cg.writeln("::wasm_bindgen::JsCast::unchecked_from_js_ref(self.as_ref())");
				});
			}
		});
		cg.writeln();
	}

	let allProps : data.Variable[] = [];
	{
		let addedProps = new Set<string>();
		theInterface.forEachSuperImpl((i) => {
			i.properties.forEach((p) => {
				if (!addedProps.has(p.rustName)) {
					allProps.push(p);
					addedProps.add(p.rustName);
				}
			});
		});
		theInterface.properties.forEach((p) => {
			if (!addedProps.has(p.rustName)) {
				allProps.push(p);
				addedProps.add(p.rustName);
			}
		});
	}

	cg.scope("impl "+theInterface.rustName+" {", (cg) => {
		cg.scope("pub fn new("+util.constructCommaSeparatedString((addStrPart) => {
			allProps.forEach((prop) => {
				if (!prop.isOptional) {
					addStrPart(prop.rustName+": "+typeInArgPos(prop.type, theInterface.namespace));
				}
			});
		})+") -> "+theInterface.rustName+" {", (cg) => {
			cg.writeln("let obj : ::wasm_bindgen::JsValue = ::js_sys::Object::new().into();");
			allProps.forEach((prop) => {
				if (!prop.isOptional) {
					cg.writeln("::js_sys::Reflect::set(&obj, &\""+prop.jsName+"\".into(), "+argToRefJsValue(prop.type, prop.rustName, theInterface.namespace)+").unwrap();")
				}
			});
			cg.writeln("::wasm_bindgen::JsCast::unchecked_from_js(obj)");
		});
	});
}

function emitFunction(cg: codegen.CodeGen, resolvedFunction: data.NameResolvedFunction, kind: FunctionKind, namespace: data.Namespace, belongsToType?: data.ClassType | data.InterfaceType) {
	let theFunction = resolvedFunction.f;
	let shouldPrintDocs = (theFunction.docs != "" || theFunction.signature.args.length > 0 || !data.typesAreSame(theFunction.signature.returnType, data.Unit));
	if (shouldPrintDocs) {
		cg.writeln("/**");
		let shouldPrintParamsAndReturn = true;
		if (theFunction.docs != "") {
			let str = theFunction.docs;
			let containsParamDocs = (str.indexOf("@param") >= 0 || str.indexOf("@returns") >= 0);
			let lines = str.split("\n");
			for (let line of lines) {
				cg.writeln(" * "+line);
			}
			if (containsParamDocs) {
				shouldPrintParamsAndReturn = false;
			} else {
				cg.writeln(" *");
			}
		}
		if (shouldPrintParamsAndReturn) {
			if (theFunction.signature.args.length > 0) {
				cg.writeln(" * Parameters:");
			}
			for (let arg of theFunction.signature.args) {
				cg.writeln(" *  - "+arg.jsName+(arg.isOptional ? "?":"")+" : "+arg.jsType);
			}
			if (!data.typesAreSame(theFunction.signature.returnType, data.Unit)) {
				cg.writeln(" * Returns: "+theFunction.signature.returnJsType);
			}
		}
		cg.writeln(" */");
	}
	{
		emitSpecifiers(cg, (addSpecifier) => {
			if (kind == FunctionKind.METHOD) {
				addSpecifier("method");
				addSpecifier("structural");
			} else if (kind == FunctionKind.CONSTRUCTOR) {
				addSpecifier("constructor");
			} else if (kind == FunctionKind.FREE_FUNCTION) {
				// no specifier
			} else if (kind == FunctionKind.NAMESPACED_FUNCTION) {
				addSpecifier("js_namespace = "+namespace.jsName); // TODO: super-namespaces
			} else if (kind == FunctionKind.STATIC_METHOD && belongsToType !== undefined) {
				addSpecifier("static_method_of = "+belongsToType.rustName); // TODO: namespace
			}
			if (resolvedFunction.resolvedName != resolvedFunction.f.jsName) {
				addSpecifier("js_name = "+resolvedFunction.f.jsName);
			}
		});
		cg.writeln("pub fn "+resolvedFunction.resolvedName+"("+util.constructCommaSeparatedString((addStrPart) => {
			if (belongsToType !== undefined && kind == FunctionKind.METHOD) {
				addStrPart("this: "+typeInArgPos(belongsToType, namespace));
			}
			theFunction.signature.args.forEach((arg) => {
				addStrPart(arg.rustName + ": " + typeInArgPos(arg.type, namespace));
			});
		}) + ")" + (data.typesAreSame(theFunction.signature.returnType, data.Unit) ? "" : " -> " + typeInReturnPos(theFunction.signature.returnType, namespace))+";");
		cg.writeln();
	}
}

function emitNamespace(cg: codegen.CodeGen, theNamespace: data.Namespace) {
	util.forEachKeyValueInObject(theNamespace.subNamespaces, (subNsName, subNS) => {
		cg.scope("pub mod "+subNS.rustName+" {", (cg) => {
			cg.writeln("use super::*;");
			cg.writeln();
			emitNamespace(cg, subNS);
		});
		cg.writeln();
	});

	util.forEachKeyValueInObject(theNamespace.classes, (className, theClass) => {
		emitClass(cg, theClass);
	});

	util.forEachKeyValueInObject(theNamespace.interfaces, (className, theInterface) => {
		emitInterface(cg, theInterface);
	});

	if (theNamespace.staticFunctions.count() > 0) {
		cg.writeln("#[wasm_bindgen]");
		cg.scope("extern {", (cg) => {
			if (theNamespace.parent == undefined) {
				theNamespace.staticFunctions.forEachResolvedFunction((f) => {
					emitFunction(cg, f, FunctionKind.FREE_FUNCTION, theNamespace);
				});
			} else {
				theNamespace.staticFunctions.forEachResolvedFunction((f) => {
					emitFunction(cg, f, FunctionKind.NAMESPACED_FUNCTION, theNamespace);
				});
			}
		});
	}
}

export function emitCargoToml(packageName: string) : string {
	return "" +
	"[package]\n" +
	"name = \""+packageName+"\"\n" +
	"version = \"1.0.0\"\n" +
	"authors = [\"dts2rs\"]\n" +
	"\n" + 
	//"[lib]\n" + 
	//"crate-type = [\"staticlib\"]\n" +
	//"\n" + 
	"[dependencies.js-sys]\n" +
	"version = \"*\"\n" +
	"git = \"https://github.com/rustwasm/wasm-bindgen.git\"\n" +
	"\n" + 
	"[dependencies.wasm-bindgen]\n" +
	"version = \"*\"\n" +
	"git = \"https://github.com/rustwasm/wasm-bindgen.git\"\n";
}

export function emitLibRs(cg: codegen.CodeGen, program: data.Program) {
	let rootNameSpace = program.rootNameSpace;
	let closures = program.closures;
	
	cg.writeln("#![allow(non_camel_case_types, non_snake_case)]");
	cg.writeln();
	cg.writeln("extern crate wasm_bindgen;");
	cg.writeln("extern crate js_sys;");
	cg.writeln();
	cg.writeln("use wasm_bindgen::prelude::*;");
	cg.writeln();

	emitNamespace(cg, rootNameSpace);
}
