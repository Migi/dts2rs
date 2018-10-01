import * as data from "./data";

export function forEachKeyValueInObject<T>(obj: {[key:string]:T}, cb: (key:string, value:T) => void) {
	for (const key in obj) {
		if (obj.hasOwnProperty(key)) {
			cb(key, obj[key]);
		}
	}
}

export function forEach<T>(list:ReadonlyArray<T> | undefined, cb: (value:T, index:number, array:ReadonlyArray<T>) => void) {
	if (list !== undefined) {
		list.forEach(cb);
	}
}

export function numToAbc(num:number) : string {
	let neg = false;
	if (num < 0) {
		neg = true;
		num = -num;
	} else if (num == 0) {
		return "a";
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

export const rustKeywords = {
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

export function escapeRustName(name:string) : string {
	while (
		name.length > 2 && (
			(name.charCodeAt(0) == 34 && name.charCodeAt(name.length-1) == 34) ||
			(name.charCodeAt(0) == 39 && name.charCodeAt(name.length-1) == 39)
		)
	) {
		name = name.substr(1, name.length-2);
	}
	if (rustKeywords.hasOwnProperty(name)) {
		name = name+"__";
	}
	let newName = "";
	for (let i = 0; i < name.length; i++) {
		let c = name.charCodeAt(i);
		if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57 && i > 0) || c == 95) {
			newName += String.fromCharCode(c);
		} else if (c == 45 || c == 46) {
			newName += "_";
		} else {
			newName += "_Ux"+c.toString(16);
		}
	}
	return newName;
}

export function constructString<R>(f: (addPart: (s: string) => void) => void) : string {
	let result = "";
	let addPart = (s:string) => {
		result += s;
	};
	f(addPart);
	return result;
}

export function constructCommaSeparatedString<R>(f: (addPart: (s: string) => void) => void) : string {
	let result = "";
	let addPart = (s:string) => {
		if (result != "") {
			result += ", ";
		}
		result += s;
	};
	f(addPart);
	return result;
}

// TODO: deprecated
export function indentAdder(writeln: (s:string) => void) : (s:string) => void {
	return (s) => {
		if (s.length == 0) {
			writeln("");
		} else {
			writeln("\t"+s);
		}
	};
}
