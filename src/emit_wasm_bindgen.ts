/// This file emits .rs code to be used with wasm_bindgen

import * as data from "./data";
import * as util from "./util";

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
		case "string": return "&str";
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
		case "interface": return "impl "+curNS.getRustPathTo(type.namespace, type.rustName);
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
		case "string": return "::wasm_bindgen::JsString";
		case "bool": return "bool";
		case "symbol": return "::js_sys::Symbol";
		case "undefined": return "()"; // wasm_bindgen has no type representing undefined
		case "null": return "()"; // wasm_bindgen has no type representing null
		case "void": return "()";
		case "never": return "()"; // change this when rust never types are stabilized
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

function emitDocs(docs: string, writeln: (s:string) => void) : void {
	if (docs == "") {
		return;
	}
	let lines = docs.split("\n");
	for (const docLine of lines) {
		writeln("/// "+docLine);
	}
}

function emitClass(writeln: (s:string) => void, theClass: data.ClassType) : void {
	emitDocs(theClass.docs, writeln);

	let typeSpecifiers = "";
	theClass.forEachSuperClass((c) => {
		if (typeSpecifiers != "") {
			typeSpecifiers += ", ";
		}
		typeSpecifiers += "extends = "+c.rustName;
	});

	if (typeSpecifiers != "") {
		writeln("#[wasm_bindgen("+typeSpecifiers+")]");
	}
	writeln("pub type "+theClass.rustName+";");
	writeln("");

	let dontOutputThese = new Set<string>();
	theClass.forEachSuperClass((c) => {
		c.properties.forEach((p) => {
			dontOutputThese.add(p.rustName);
			dontOutputThese.add("set_"+p.rustName);
		});
	});
	theClass.forEachSuperImpl((i) => {
		i.properties.forEach((p) => {
			dontOutputThese.add(p.rustName);
			dontOutputThese.add("set_"+p.rustName);
		});
	});
	writeln("{");
	theClass.methods.forEachResolvedFunction((method) => {
		if (!dontOutputThese.has(method.f.unresolvedRustName)) {
			emitFunction(util.indentAdder(writeln), method, FunctionKind.METHOD, true, theClass.namespace);
		}
	});
	theClass.properties.forEach((prop) => {
		if (!dontOutputThese.has("get_"+prop.rustName)) {
			writeln("\tfn get_"+prop.rustName+"(&self) -> "+typeInReturnPos(prop.type, theClass.namespace)+" {");
			writeln("\t\t"+constructTypeFromJsValue(prop.type, theClass.namespace, "js!(return @{self}."+prop.jsName+";)"));
			writeln("\t}");
		}
		if (!dontOutputThese.has("set_"+prop.rustName)) {
			writeln("\tfn set_"+prop.rustName+"(&self, "+prop.rustName+": "+typeInArgPos(prop.type, theClass.namespace)+") -> &Self {");
			writeln("\t\tjs!(@(no_return) @{self}."+prop.jsName+" = @{"+prop.rustName+"};);");
			writeln("\t\tself");
			writeln("\t}");
			writeln("");
		}
	});
	writeln("}");
	writeln("");
	writeln("impl<T: ::stdweb::JsSerialize> "+subClassOfTrait+" for Any<T> {}");
	writeln("");

	emitRefTypeTraits(theClass.rustName, writeln);

	theClass.forEachSuperClass((superClass) => {
		writeln("impl "+ theClass.namespace.getRustPathTo(superClass.namespace, getSubClassOfTraitName(superClass)) +" for "+theClass.rustName+" {}");
		writeln("impl<'a> "+ theClass.namespace.getRustPathTo(superClass.namespace, getSubClassOfTraitName(superClass)) +" for &'a "+theClass.rustName+" {}"); // TODO: should we do this impl?
	});
	theClass.forEachSuperImpl((i) => {
		writeln("impl "+ theClass.namespace.getRustPathTo(i.namespace, getImplementsTraitName(i)) +" for "+theClass.rustName+" {}");
		writeln("impl<'a> "+ theClass.namespace.getRustPathTo(i.namespace, getImplementsTraitName(i)) +" for &'a "+theClass.rustName+" {}");
	});
	
	writeln("impl "+ subClassOfTrait +" for "+theClass.rustName+" {}");
	writeln("impl<'a> "+ subClassOfTrait +" for &'a "+theClass.rustName+" {}");
	writeln("");

	writeln("pub struct __"+theClass.rustName+"_Prototype(::stdweb::Reference);");
	writeln("");
	writeln("impl __"+theClass.rustName+"_Prototype {");
	writeln("\tpub fn __from_js_value(__value: ::stdweb::Value) -> Self {");
	writeln("\t\tSelf::__try_from_js_value(__value).unwrap_or_else(|err| panic!(err))");
	writeln("\t}");
	writeln("");
	writeln("\tpub fn __try_from_js_value(__value: ::stdweb::Value) -> Result<Self, &'static str> {");
	writeln("\t\tmatch __value {");
	writeln("\t\t\t::stdweb::Value::Reference(__js_ref) => Ok(__"+theClass.rustName+"_Prototype(__js_ref)),");
	writeln("\t\t\t_ => Err(\"Failed to initialize prototype of class "+theClass.rustName+" in "+theClass.namespace.toStringFull()+": the given stdweb::Value is not a reference.\")");
	writeln("\t\t}");
	writeln("\t}");
	writeln("");
	writeln("\tpub fn __from_js_ref(__js_ref: ::stdweb::Reference) -> Self {");
	writeln("\t\t__"+theClass.rustName+"_Prototype(__js_ref)");
	writeln("\t}");
	writeln("");
	theClass.constructors.forEachResolvedFunction((constructor) => {
		emitFunction(util.indentAdder(writeln), constructor, FunctionKind.CONSTRUCTOR, true, theClass.namespace);
	});
	theClass.staticMethods.forEachResolvedFunction((staticMethod) => {
		emitFunction(util.indentAdder(writeln), staticMethod, FunctionKind.CONSTRUCTOR, true, theClass.namespace);
	});
	writeln("}");
	writeln("");
	emitRefTypeTraits("__"+theClass.rustName+"_Prototype", writeln);
}

function emitInterface(writeln: (s:string) => void, theInterface: data.InterfaceType) : void {
	let implementsTrait = getImplementsTraitName(theInterface);

	emitDocs(theInterface.docs, writeln);
	writeln("pub struct "+theInterface.rustName+"(pub ::stdweb::Reference);");
	writeln("");
	writeln("pub trait "+implementsTrait+":");
	writeln("\t::stdweb::JsSerialize +");
	for (let i of theInterface.directImpls) {
		writeln("\t"+theInterface.namespace.getRustPathTo(i.namespace, getImplementsTraitName(i))+" +");
	}

	let dontOutputThese = new Set<string>();
	let allProps : data.Variable[] = [];
	theInterface.forEachSuperImpl((i) => {
		i.methods.forEachUnresolvedFunction((f) => {
			dontOutputThese.add(f.unresolvedRustName);
		});
		i.properties.forEach((p) => {
			if (!dontOutputThese.has("get_"+p.rustName) || !dontOutputThese.has("set_"+p.rustName)) {
				allProps.push(p);
			}
			dontOutputThese.add("get_"+p.rustName);
			dontOutputThese.add("set_"+p.rustName);
		});
	});
	theInterface.properties.forEach((p) => {
		if (!dontOutputThese.has("get_"+p.rustName) || !dontOutputThese.has("set_"+p.rustName)) {
			allProps.push(p);
		}
	});

	writeln("{");
	theInterface.methods.forEachResolvedFunction((method) => {
		if (!dontOutputThese.has(method.f.unresolvedRustName)) {
			emitFunction(util.indentAdder(writeln), method, FunctionKind.METHOD, true, theInterface.namespace);
		}
	})
	theInterface.properties.forEach((prop) => {
		if (!dontOutputThese.has("get_"+prop.rustName)) {
			writeln("\tfn get_"+prop.rustName+"(&self) -> "+typeInReturnPos(prop.type, theInterface.namespace)+" {");
			writeln("\t\t"+constructTypeFromJsValue(prop.type, theInterface.namespace, "js!(return @{self}."+prop.jsName+";)"));
			writeln("\t}");
		}
		if (!dontOutputThese.has("set_"+prop.rustName)) {
			writeln("\tfn set_"+prop.rustName+"(&self, "+prop.rustName+": "+typeInArgPos(prop.type, theInterface.namespace)+") -> &Self {");
			writeln("\t\tjs!(@(no_return) @{self}."+prop.jsName+" = @{"+prop.rustName+"};);");
			writeln("\t\tself");
			writeln("\t}");
		}
	});
	writeln("}");
	writeln("");
	theInterface.forEachSuperImpl((i) => {
		writeln("impl "+ theInterface.namespace.getRustPathTo(i.namespace, getImplementsTraitName(i)) +" for "+theInterface.rustName+" {}");
		writeln("impl<'a> "+ theInterface.namespace.getRustPathTo(i.namespace, getImplementsTraitName(i)) +" for &'a "+theInterface.rustName+" {}"); // TODO: do we need this?
	});
	writeln("impl "+implementsTrait+" for "+theInterface.rustName+" {}");
	writeln("impl<'a> "+implementsTrait+" for &'a "+theInterface.rustName+" {}");
	writeln("impl<T: ::stdweb::JsSerialize> "+implementsTrait+" for Any<T> {}");
	writeln("");
	
	emitRefTypeTraits(theInterface.rustName, writeln);
	
	writeln("pub struct __"+theInterface.rustName+"_Prototype {");
	writeln("}");
	writeln("");
	writeln("impl __"+theInterface.rustName+"_Prototype {");
	let defLine = "\tpub fn new(&self";
	allProps.forEach((prop) => {
		if (!prop.isOptional) {
			defLine += ", "+prop.rustName+": "+typeInArgPos(prop.type, theInterface.namespace);
		}
	});
	defLine += ") -> "+theInterface.rustName+" {";
	writeln(defLine);
	let implLine = "\t\t"+theInterface.rustName+"(__js_value_into_reference(js!(return {";
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
	implLine += "};), \"object implementing "+theInterface.rustName+"\"))";
	writeln(implLine);
	writeln("\t}");
	writeln("}");
	writeln("");
}

function emitFunction(writeln: (s:string) => void, resolvedFunction: data.NameResolvedFunction, kind: FunctionKind, withImplementation: boolean, namespace: data.Namespace) {
	let theFunction = resolvedFunction.f;
	let shouldPrintDocs = (theFunction.docs != "" || theFunction.signature.args.length > 0 || !data.typesAreSame(theFunction.signature.returnType, data.Unit));
	if (shouldPrintDocs) {
		writeln("/**");
		let shouldPrintParamsAndReturn = true;
		if (theFunction.docs != "") {
			let str = theFunction.docs;
			let containsParamDocs = (str.indexOf("@param") >= 0 || str.indexOf("@returns") >= 0);
			let lines = str.split("\n");
			for (let line of lines) {
				writeln(" * "+line);
			}
			if (containsParamDocs) {
				shouldPrintParamsAndReturn = false;
			} else {
				writeln(" *");
			}
		}
		if (shouldPrintParamsAndReturn) {
			if (theFunction.signature.args.length > 0) {
				writeln(" * Parameters:");
			}
			for (let arg of theFunction.signature.args) {
				writeln(" *  - "+arg.jsName+(arg.isOptional ? "?":"")+" : "+arg.jsType);
			}
			if (!data.typesAreSame(theFunction.signature.returnType, data.Unit)) {
				writeln(" * Returns: "+theFunction.signature.returnJsType);
			}
		}
		writeln(" */");
	}
	{
		let line = "";
		if (kind != FunctionKind.METHOD) {
			line += "pub ";
		}
		line += "fn "+resolvedFunction.resolvedName+"(";
		let isFirstParam = true;
		if (kind != FunctionKind.FREE_FUNCTION) {
			line += "&self";
			isFirstParam = false;
		}
		theFunction.signature.args.forEach((arg) => {
			if (!isFirstParam) {
				line += ", ";
			}
			isFirstParam = false;
			line += arg.rustName + ": " + typeInArgPos(arg.type, namespace);
		});
		line += ") -> "+typeInReturnPos(theFunction.signature.returnType, namespace);
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
		if (data.typesAreSame(theFunction.signature.returnType, data.Unit)) {
			jsLine += "@(no_return) ";
		} else {
			jsLine += "return ";
		}
		if (kind == FunctionKind.METHOD || kind == FunctionKind.NAMESPACED_FUNCTION || kind == FunctionKind.STATIC_METHOD) {
			jsLine += "@{self}."+resolvedFunction.resolvedName+"(";
		} else if (kind == FunctionKind.CONSTRUCTOR) {
			jsLine += "new @{self}(";
		} else if (kind == FunctionKind.FREE_FUNCTION) {
			jsLine += resolvedFunction.resolvedName+"(";
		}
		let isFirstParam = true;
		theFunction.signature.args.forEach((arg) => {
			if (!isFirstParam) {
				jsLine += ", ";
			}
			isFirstParam = false;
			jsLine += "@{"+arg.rustName+"}";
		});
		jsLine += ");)";
		line += constructTypeFromJsValue(theFunction.signature.returnType, namespace, jsLine);
		writeln(line);
		writeln("}");
		writeln("");
	}
}

function emitNamespace(writeln: (s:string) => void, theNamespace: data.Namespace) {
	util.forEachKeyValueInObject(theNamespace.subNamespaces, (subNsName, subNS) => {
		writeln("pub mod "+subNS.rustName+" {");
		writeln("\tuse super::*;");
		writeln("");
		emitNamespace(util.indentAdder(writeln), subNS);
		writeln("}");
		writeln("");
	});

	util.forEachKeyValueInObject(theNamespace.classes, (className, theClass) => {
		emitClass(writeln, theClass);
	});

	util.forEachKeyValueInObject(theNamespace.interfaces, (className, theInterface) => {
		emitInterface(writeln, theInterface);
	});

	let eagerNamespaceRustName = "__EagerNamespace_"+theNamespace.rustName;
	if (theNamespace.parent == undefined) {
		eagerNamespaceRustName = "__EagerGlobals";
	}

	writeln("pub struct "+eagerNamespaceRustName+" {");
	writeln("\t__js_ref: ::stdweb::Reference,");
	util.forEachKeyValueInObject(theNamespace.subNamespaces, (subNsName, subNS) => {
		writeln("\tpub "+subNS.rustName+": "+subNS.rustName+"::__EagerNamespace_"+subNS.rustName+",");
	});
	util.forEachKeyValueInObject(theNamespace.classes, (className, theClass) => {
		writeln("\tpub "+theClass.rustName+": __"+theClass.rustName+"_Prototype,");
	});
	util.forEachKeyValueInObject(theNamespace.interfaces, (className, theInterface) => {
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
	writeln("\t\t\t_ => Err(\"Failed to initialize "+theNamespace.toStringFull()+": the given stdweb::Value is not a reference.\")");
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
	util.forEachKeyValueInObject(theNamespace.subNamespaces, (subNsName, subNS) => {
		writeln("\t\t\t"+subNS.rustName+": "+subNS.rustName+"::__EagerNamespace_"+subNS.rustName+"::__try_from_js_value(js!(return @{__js_ref}."+subNS.jsName+";))?,");
	});
	util.forEachKeyValueInObject(theNamespace.classes, (className, theClass) => {
		writeln("\t\t\t"+theClass.rustName+": __"+theClass.rustName+"_Prototype::__try_from_js_value(js!(return @{__js_ref}."+theClass.jsName+";))?,");
	});
	util.forEachKeyValueInObject(theNamespace.interfaces, (interfaceName, theInterface) => {
		writeln("\t\t\t"+theInterface.rustName+": __"+theInterface.rustName+"_Prototype {},");
	});
	writeln("\t\t})");
	writeln("\t}");
	writeln("}");
	writeln("");

	emitImplJsSerializeForType(eagerNamespaceRustName, "self.__js_ref", writeln);

	let lazyNamespaceRustName = "__LazyNamespace_"+theNamespace.rustName;
	if (theNamespace.parent == undefined) {
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
	writeln("\t\t\t_ => Err(\"Failed to initialize "+theNamespace.toStringFull()+": the given stdweb::Value is not a reference.\")");
	writeln("\t\t}");
	writeln("\t}");
	writeln("");
	writeln("\tpub fn __from_js_ref(__js_ref: ::stdweb::Reference) -> Self {");
	writeln("\t\t"+lazyNamespaceRustName+"(__js_ref)");
	writeln("\t}");
	writeln("");
	util.forEachKeyValueInObject(theNamespace.subNamespaces, (subNsName, subNS) => {
		writeln("\tpub fn "+subNS.rustName+"(&self) -> "+subNS.rustName+"::__LazyNamespace_"+subNS.rustName+" {");
		writeln("\t\t"+subNS.rustName+"::__LazyNamespace_"+subNS.rustName+"::__from_js_value(js!(return @{self}."+subNS.jsName+";))");
		writeln("\t}");
		writeln("");
	});
	util.forEachKeyValueInObject(theNamespace.classes, (className, theClass) => {
		writeln("\tpub fn "+theClass.rustName+"(&self) -> __"+theClass.rustName+"_Prototype {");
		writeln("\t\t__"+theClass.rustName+"_Prototype::__from_js_value(js!(return @{self}."+theClass.jsName+";))");
		writeln("\t}");
		writeln("");
	});
	util.forEachKeyValueInObject(theNamespace.interfaces, (className, theInterface) => {
		writeln("\tpub fn "+theInterface.rustName+"(&self) -> __"+theInterface.rustName+"_Prototype {");
		writeln("\t\t__"+theInterface.rustName+"_Prototype {}");
		writeln("\t}");
		writeln("");
	});
	if (theNamespace.parent != undefined) {
		theNamespace.staticFunctions.forEachResolvedFunction((f) => {
			emitFunction(util.indentAdder(writeln), f, FunctionKind.NAMESPACED_FUNCTION, true, theNamespace);
		});
	}
	writeln("}");
	writeln("");
	
	emitRefTypeTraits(lazyNamespaceRustName, writeln);

	if (theNamespace.parent == undefined) {
		theNamespace.staticFunctions.forEachResolvedFunction((f) => {
			emitFunction(writeln, f, FunctionKind.FREE_FUNCTION, true, theNamespace);
		});
	}
}

function emitPreludeForNamespace(writeln: (s:string) => void, theNamespace: data.Namespace) {
	util.forEachKeyValueInObject(theNamespace.classes, (className, theClass) => {
		writeln("pub use "+theClass.namespace.getFullyQualifiedPathToMember(getSubClassOfTraitName(theClass))+";");
	});

	util.forEachKeyValueInObject(theNamespace.interfaces, (className, theInterface) => {
		writeln("pub use "+theInterface.namespace.getFullyQualifiedPathToMember(getImplementsTraitName(theInterface))+";");
	});
	
	util.forEachKeyValueInObject(theNamespace.subNamespaces, (subNsName, subNS) => {
		emitPreludeForNamespace(writeln, subNS);
	});
}

export function emitCargoToml(packageName: string) : string {
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

export function emitLibRs(writeln: (s:string) => void, program: data.Program) {
	let rootNameSpace = program.rootNameSpace;
	let closures = program.closures;
	
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

	closures.forEach((f) => {
		let fStructName = underscoreEscapeSignature("JsFn", f);
		let fTraitName = underscoreEscapeSignature("JsCallable", f);
		writeln("pub struct "+fStructName+"(::stdweb::Reference);");
		writeln("");
		emitRefTypeTraits(fStructName, writeln);
		writeln("impl __JsCallable for "+fStructName+" {}");
		writeln("impl<'a> __JsCallable for &'a "+fStructName+" {}");
		writeln("");
		writeln("pub trait "+fTraitName+" : __JsCallable + ::stdweb::JsSerialize {");
		let fnDefLine = "\tfn call(&self";
		for (let i = 0; i < f.args.length; i++) {
			fnDefLine += ", arg"+(i+1)+": "+typeInArgPos(f.args[i].type, rootNameSpace);
		}
		fnDefLine += ") -> "+typeInReturnPos(f.returnType, rootNameSpace)+" {";
		writeln(fnDefLine);
		let jsLine = "js!(return @{self}(";
		if (data.typesAreSame(f.returnType, data.Unit)) {
			jsLine = "js!(@(no_return) @{self}("
		}
		for (let i = 0; i < f.args.length; i++) {
			if (i != 0) {
				jsLine += ", ";
			}
			jsLine += "@{arg"+(i+1)+"}";
		}
		jsLine += ");)";
		writeln("\t\t"+constructTypeFromJsValue(f.returnType, rootNameSpace, jsLine));
		writeln("\t}");
		writeln("}");
		writeln("");
		writeln("impl "+fTraitName+" for "+fStructName+" {}");
		writeln("impl<'a> "+fTraitName+" for &'a "+fStructName+" {}");
		writeln("impl<T: ::stdweb::JsSerialize> "+fTraitName+" for Any<T> {}");
		let boundsStr = "";
		let paramsStr = "";
		for (let i = 0; i < f.args.length; i++) {
			let argStr = typeInArgPos(f.args[i].type, rootNameSpace);
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

	emitNamespace(writeln, rootNameSpace);

	writeln("pub mod prelude {");
	writeln("\tpub use Any;");
	writeln("\tpub use AsAny;");
	writeln("\tpub use FnHandle;");
	emitPreludeForNamespace(util.indentAdder(writeln), rootNameSpace);
	closures.forEach((f) => {
		let fTraitName = underscoreEscapeSignature("JsCallable", f);
		writeln("\tpub use "+fTraitName+";");
	});
	writeln("}");
}
