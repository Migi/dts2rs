import * as util from "./util";

export interface Program {
	rootNameSpace: Namespace,
	closures: FunctionType[]
};

export type Type = AnyType | UnknownType | NumberType | StringType | BoolType | SymbolType | UndefinedType | NullType | UnitType | NeverType | OptionalType | ClassType | InterfaceType | FunctionType;

export interface AnyType {
	kind: "any",
	canBeUndefined: true
}
export const Any: AnyType = {
	kind: "any",
	canBeUndefined: true
}

export interface UnknownType {
	kind: "unknown",
	canBeUndefined: true
}
export const Unknown: UnknownType = {
	kind: "unknown",
	canBeUndefined: true
}

export interface NumberType {
	kind: "number",
	canBeUndefined: false
}
export const Number: NumberType = {
	kind: "number",
	canBeUndefined: false
}

export interface StringType {
	kind: "string",
	canBeUndefined: false
}
export const String: StringType = {
	kind: "string",
	canBeUndefined: false
}

export interface BoolType {
	kind: "bool",
	canBeUndefined: false
}
export const Bool: BoolType = {
	kind: "bool",
	canBeUndefined: false
}

export interface SymbolType {
	kind: "symbol",
	canBeUndefined: false
}
export const Symbol: SymbolType = {
	kind: "symbol",
	canBeUndefined: false
}

export interface UndefinedType {
	kind: "undefined",
	canBeUndefined: true
}
export const Undefined: UndefinedType = {
	kind: "undefined",
	canBeUndefined: true
}

export interface NullType {
	kind: "null",
	canBeUndefined: false
}
export const Null: NullType = {
	kind: "null",
	canBeUndefined: false
}

export interface UnitType {
	kind: "void",
	canBeUndefined: false
}
export const Unit: UnitType = {
	kind: "void",
	canBeUndefined: false
}

export interface NeverType {
	kind: "never",
	canBeUndefined: false
}
export const Never: NeverType = {
	kind: "never",
	canBeUndefined: false
}

export interface OptionalType {
	kind: "optional";
	subtype: Type;
	canBeUndefined: true;
}

export class Optional {
	constructor(public subtype: Type) {
		this.kind = "optional";
		this.canBeUndefined = true;
	}
	kind: "optional";
	canBeUndefined: true;
}

export function getTypeShortName(t: Type) : string {
	switch (t.kind) {
		case "any": return "Any";
		case "unknown": return "Unknown";
		case "number": return "Number";
		case "string": return "String";
		case "bool": return "Bool";
		case "symbol": return "Symbol";
		case "undefined": return "Undefined";
		case "null": return "Null";
		case "void": return "Void";
		case "never": return "Never"; // change this when rust never types are stabilized
		case "optional": return "Optional"+getTypeShortName(t.subtype);
		case "class": return t.rustName;
		case "interface": return t.rustName;
		case "function": return "Fn"+t.args.length;
		default: {
			let exhaustive : never = t;
			return exhaustive;
		}
	}
}

export function typesAreSame(a: Type, b: Type) : boolean {
	return cmpTypes(a,b) === 0;
}

/// Compare types for sorting them (used for example when doing name resolution, so that that is stable).
/// Returns 0 if and only if typesAreSame(a,b) is true, so this relation is a total order.
export function cmpTypes(a: Type, b: Type) : number {
	if (a.kind != b.kind) {
		return a.kind.localeCompare(b.kind, "en");
	}
	switch (a.kind) {
		case "optional": return cmpTypes(a.subtype, (b as OptionalType).subtype);
		case "class": return a.cmp(b as ClassType);
		case "interface": return a.cmp(b as InterfaceType);
		case "function": return a.cmp(b as FunctionType);
		default: return 0;
	}
}

function* iterateResolvedNames(f: NamedFunction) {
	yield f.unresolvedRustName;

	let numArgs = f.signature.args.length;
	yield f.unresolvedRustName+"_"+numArgs;

	let numTries = 0;
	while (true) {
		yield f.unresolvedRustName+"_"+numArgs+util.numToAbc(numTries);
		numTries += 1;
	}
}

/**
 * A list of functions, possibly with duplicate names but not with exact duplicates (same name, same signature).
 * You can use this to get a list of resolved methods (with unique names and truncated versions for functions with optional arguments).
 * The list of resolved functions is cached.
 * 
 * Naming scheme for resolved functions:
 *  - If a function name happens once, just use it.
 *  - If it happens multiple times, put an underscore and a number next to it equal to its number of arguments.
 *  - If that still generates duplicates, try adding "a", "b", "c", etc. until a unique name is found.
 */
export class ListOfFunctions {
	private functions: NamedFunction[];
	private cachedResolvedFunctions: undefined | NameResolvedFunction[];
	private cachedUnresolvedNameMap: undefined | Map<string, NamedFunction[]>;
	private cachedResolvedNameMap: undefined | Map<string, NameResolvedFunction[]>;

	constructor() {
		this.functions = [];
		this.cachedResolvedFunctions = undefined;
		this.cachedUnresolvedNameMap = undefined;
		this.cachedResolvedNameMap = undefined;
	}

	add(f:NamedFunction) {
		for (let existingF of this.functions) {
			if (f.isSameAs(existingF)) {
				return;
			}
		}
		this.functions.push(f);
		this.cachedResolvedFunctions = undefined;
		this.cachedUnresolvedNameMap = undefined;
		this.cachedResolvedNameMap = undefined;
	}

	count() : number {
		return this.functions.length;
	}

	forEachUnresolvedFunction(cb: (f: NamedFunction) => void) {
		this.functions.forEach(cb);
	}

	forEachResolvedFunction(cb: (f: NameResolvedFunction) => void) {
		this.getResolvedFunctions().forEach(cb);
	}

	getResolvedFunctions() : NameResolvedFunction[] {
		if (this.cachedResolvedFunctions !== undefined) {
			return this.cachedResolvedFunctions;
		}
		let result : NameResolvedFunction[] = [];

		this.functions.sort((a, b) => {
			return a.cmp(b);
		});

		let notResolvedYet = this.functions.map((f) => {
			return {
				f: f,
				nameGen: iterateResolvedNames(f)
			};
		});

		let alreadyOutputted = new Set<string>();
		while (notResolvedYet.length > 0) {
			notResolvedYet = notResolvedYet.filter((resolver) => {
				let nameIter = resolver.nameGen.next();
				console.assert(!nameIter.done);
				let name = nameIter.value;
				if (alreadyOutputted.has(name)) {
					return true;
				} else {
					alreadyOutputted.add(name);
					result.push(new NameResolvedFunction(name, resolver.f));
					return false;
				}
			});
		}

		this.cachedResolvedFunctions = result;
		return result;
	}

	getUnresolvedNameMap() : Map<string, NamedFunction[]> {
		if (this.cachedUnresolvedNameMap !== undefined) {
			return this.cachedUnresolvedNameMap;
		}
		let result = new Map<string, NamedFunction[]>();
		this.functions.forEach((f) => {
			let existing = result.get(f.unresolvedRustName);
			if (existing !== undefined) {
				existing.push(f);
			} else {
				let newArr = [f];
				result.set(f.unresolvedRustName, newArr);
			}
		});
		this.cachedUnresolvedNameMap = result;
		return result;
	}

	getResolvedNameMap() : Map<string, NameResolvedFunction[]> {
		if (this.cachedResolvedNameMap !== undefined) {
			return this.cachedResolvedNameMap;
		}
		let result = new Map<string, NameResolvedFunction[]>();
		this.getResolvedFunctions().forEach((f) => {
			let existing = result.get(f.resolvedName);
			if (existing !== undefined) {
				existing.push(f);
			} else {
				let newArr = [f];
				result.set(f.resolvedName, newArr);
			}
		});
		this.cachedResolvedNameMap = result;
		return result;
	}
}

export class ClassOrInterface {
	constructor(public jsName: string, public namespace: Namespace, public docs: string) {
		this.rustName = util.escapeRustName(this.jsName);
		this.directImpls = [];
		this.methods = new ListOfFunctions();
		this.properties = [];
		this.canBeUndefined = false;
	}

	rustName: string;
	directImpls: InterfaceType[];
	methods: ListOfFunctions;
	properties: Variable[];
	canBeUndefined: false;

	cmp(other: ClassOrInterface) : number {
		if (this.rustName != other.rustName) {
			return this.rustName.localeCompare(other.rustName, "en");
		} else {
			return this.namespace.cmp(other.namespace);
		}
	}

	addMethod(f:NamedFunction) {
		this.methods.add(f);
	}

	pushDirectImpl(i:InterfaceType) {
		for (let ownI of this.directImpls) {
			if (ownI.rustName == i.rustName) {
				return;
			}
		}
		this.directImpls.push(i);
	}
}

export class ClassType extends ClassOrInterface {
	constructor(jsName: string, public namespace: Namespace, docs: string) {
		super(jsName, namespace, docs);
		this.superClass = undefined;
		this.kind = "class";
		this.constructors = new ListOfFunctions();
		this.staticMethods = new ListOfFunctions();
	}

	superClass: ClassType | undefined;
	kind: "class";
	constructors: ListOfFunctions;
	staticMethods: ListOfFunctions;

	addConstructor(f:NamedFunction) {
		this.constructors.add(f);
	}

	addStaticMethod(f:NamedFunction) {
		this.staticMethods.add(f);
	}

	forEachSuperClass(cb: (i:ClassType) => void) {
		if (this.superClass !== undefined) {
			this.superClass.forEachSuperClass(cb);
			cb(this.superClass);
		}
	}

	forEachSuperImpl(cb: (i:InterfaceType) => void) {
		let visited = new Set<InterfaceType>();
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
}

export class InterfaceType extends ClassOrInterface {
	constructor(jsName: string, public namespace: Namespace, docs: string) {
		super(jsName, namespace, docs);
		this.kind = "interface";
	}

	kind: "interface";

	forEachSuperImpl(cb: (i:InterfaceType) => void) {
		let visited = new Set<InterfaceType>();
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
}

export class Variable {
	constructor(public jsName: string, public jsType: string, public rustName: string, public type: Type, public isOptional: boolean) {}

	isSameAs(other: Variable) : boolean {
		return this.cmp(other) === 0;
	}

	cmp(other: Variable) : number {
		if (this.rustName != other.rustName) {
			return this.rustName.localeCompare(other.rustName, "en");
		} else {
			return cmpTypes(this.type, other.type);
		}
	}
}

/// The signature of a function
export class FunctionType {
	constructor(public args: Variable[], public returnType: Type, public returnJsType: string) {
		this.kind = "function";
		this.canBeUndefined = false;
	}

	kind: "function";
	canBeUndefined: false;

	isSameAs(other: FunctionType) : boolean {
		return this.cmp(other) == 0;
	}

	cmp(other: FunctionType) : number {
		if (this.args.length != other.args.length) {
			return this.args.length - other.args.length;
		}
		for (let i = 0; i < this.args.length; i++) {
			let c = this.args[i].cmp(other.args[i]);
			if (c !== 0) {
				return c;
			}
		}
		return cmpTypes(this.returnType, other.returnType);
	}
	
	underscoreEscapeSignature(base: string) : string {
		let result = base;
		if (this.args.length > 0) {
			if (base.length > 0) {
				result += "__";
			}
			let isFirstParam = true;
			this.args.forEach((arg) => {
				if (!isFirstParam) {
					result += "_";
				}
				isFirstParam = false;
				result += getTypeShortName(arg.type);
			});
		}
		result += "__"+getTypeShortName(this.returnType);
		return result;
	}
}

export class NameResolvedFunction {
	constructor(public resolvedName: string, public f: NamedFunction) {}
}

export class NamedFunction {
	constructor(public unresolvedRustName: string, public jsName: string, public signature: FunctionType, public docs: string) {}
	
	isSameAs(other: NamedFunction) : boolean {
		return this.cmp(other) == 0;
	}

	cmp(other: NamedFunction) : number {
		if (this.unresolvedRustName != other.unresolvedRustName) {
			return this.unresolvedRustName.localeCompare(other.unresolvedRustName, "en");
		}
		return this.signature.cmp(other.signature);
	}
}

export class Namespace {
	constructor(public parent: Namespace | undefined, public jsName: string) {
		if (this.jsName === "" && this.parent !== undefined) {
			console.error("Namespace without name found that isn't the root namespace!");
			console.error("Parent: "+this.parent.toStringFull());
			throw "terminating...";
		}
		this.rustName = util.escapeRustName(this.jsName);
		this.subNamespaces = {};
		this.classes = {};
		this.interfaces = {};
		this.staticFunctions = new ListOfFunctions();
	}

	rustName: string;
	subNamespaces: {[name:string]: Namespace};
	classes: {[name:string]: ClassType};
	interfaces: {[name:string]: InterfaceType};
	staticFunctions: ListOfFunctions;

	cmp(other: Namespace) : number {
		return this.toStringFull().localeCompare(other.toStringFull(), "en");
	}

	toStringFull() : string {
		function rec(ns:Namespace) : string {
			if (ns.parent === undefined) {
				return ns.rustName;
			} else {
				let r = rec(ns.parent);
				if (r == "") {
					return ns.rustName;
				} else {
					return r + "::" + ns.rustName;
				}
			}
		}

		let r = rec(this);
		if (r == "") {
			return "the root namespace";
		} else {
			return "namespace "+r;
		}
	}

	addStaticFunction(f:NamedFunction) {
		this.staticFunctions.add(f);
	}

	private getOrCreateItemOfType<T>(jsName: string, nameMap: {[name:string]: T}, creator: () => T) : T {
		let rustName = util.escapeRustName(jsName);
		if (nameMap.hasOwnProperty(rustName)) {
			return nameMap[rustName];
		} else {
			let newItem = creator();
			nameMap[rustName] = newItem;
			return newItem;
		}
	}

	getOrCreateSubNamespace(jsName: string) : Namespace {
		return this.getOrCreateItemOfType(jsName, this.subNamespaces, () => new Namespace(this, jsName));
	}

	getOrCreateClass(jsName: string, docs: string) : ClassType {
		return this.getOrCreateItemOfType(jsName, this.classes, () => new ClassType(jsName, this, docs));
	}

	getOrCreateInterface(jsName: string, docs: string) : InterfaceType {
		return this.getOrCreateItemOfType(jsName, this.interfaces, () => new InterfaceType(jsName, this, docs));
	}

	getFullyQualifiedPath() : string {
		let result = "";
		let node : Namespace | undefined = this;
		while (node !== undefined) {
			result = "::"+node.rustName+result;
			node = node.parent;
		}
		return result;
	}

	getFullyQualifiedPathToMember(itemName: string) : string {
		return this.getFullyQualifiedPath()+"::"+itemName;
	}

	getRustPathTo(other: Namespace, itemName: string) : string {
		let fromHere = new Map<Namespace, string>();
		let fqn : string | undefined = undefined;
		function rec(node: Namespace, pathSoFar: string) {
			fromHere.set(node, pathSoFar);
			if (node.parent !== undefined) {
				if (node.rustName !== "") {
					if (pathSoFar != "") {
						rec(node.parent, node.rustName + "::" + pathSoFar);
					} else {
						rec(node.parent, node.rustName);
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
}
