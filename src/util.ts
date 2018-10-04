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

export function jsNameToRustName(name:string, toSnakeCase: boolean) : string {
	while (
		name.length > 2 && (
			(name.charCodeAt(0) == 34 && name.charCodeAt(name.length-1) == 34) ||
			(name.charCodeAt(0) == 39 && name.charCodeAt(name.length-1) == 39)
		)
	) {
		name = name.substr(1, name.length-2);
	}
	// Converting camel case to snake case is actually kind of hard. There are names like encodeURIComponent(),
	// which we want to translate to encode_uri_component(), not encode_u_r_i_component().
	// The simple rule we'll do is:
	// - If there is a group of 2+ capital letters in a row followed by a lowercase letter,
	//   put exactly 1 underscore, before the last capital letter in the group.
	// - If there is a group of 2+ capital letters in a row at the end of an identifier, use no underscores.
	// This makes names like isAURIComponent() translate to is_auri_component rather than is_a_uri_component,
	// but there's no way around that, but to be fair if you use a name like that you're asking for it.
	//
	// We also change "_", "-" and "." to "_". Every other unicode character becomes "uXXXX" (surrounded by underscores if needed),
	// where XXXX is the character's hex code. Except $, that gets renamed to "dollar" (surrounded by underscores if needed).
	let newName = "";
	let lastWasCapital : boolean = false;
	let needsUnderscore : boolean = false; // whether an underscore is needed before adding new characters
	for (let i = 0; i < name.length; i++) {
		let c = name.charCodeAt(i);
		let char = String.fromCharCode(c);
		let isSmallLetter = (c >= 97 && c <= 122);
		let isCapital = (c >= 65 && c <= 90);
		let isNumber = (c >= 48 && c <= 57);
		let isUnderscoreLike = (c == 45 || c == 46 || c == 95);
		let lastCharWasUnderscore = (newName.charCodeAt(newName.length-1) == 95);

		if (isCapital) {
			if (toSnakeCase && i > 0) {
				if (!lastWasCapital) {
					needsUnderscore = true;
				} else {
					// look at the next char
					if (i+1 < name.length) {
						let nextChar = name.charCodeAt(i+1);
						let nextIsLowercase = (nextChar >= 97 && nextChar <= 122);
						if (nextIsLowercase) {
							needsUnderscore = true;
						}
					}
				}
			}
			if (needsUnderscore) {
				newName += "_";
			}
			if (toSnakeCase) {
				newName += String.fromCharCode(c+32);
			} else {
				newName += char;
			}
			needsUnderscore = false;
		} else if (isNumber) {
			if (needsUnderscore || i == 0) {
				newName += "_"
			}
			newName += char;
			needsUnderscore = false;
		} else if (isSmallLetter) {
			if (needsUnderscore) {
				newName += "_";
			}
			newName += char;
			needsUnderscore = false;
		} else if (isUnderscoreLike) {
			newName += "_";
			needsUnderscore = false;
		} else {
			if (needsUnderscore || (i > 0 && !lastCharWasUnderscore)) {
				newName += "_";
			}
			if (c == 36) {
				newName += "dollar";
			} else {
				newName += "u"+c.toString(16);
			}
			needsUnderscore = true;
		}

		if (isCapital) {
			lastWasCapital = true;
		} else {
			lastWasCapital = false;
		}
	}
	if (rustKeywords.hasOwnProperty(newName)) {
		return newName+"_";
	} else {
		return newName;
	}
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
