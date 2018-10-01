function indentAdder(writeln: (s?:string) => void) : (s?:string) => void {
	return (s) => {
		if (s === undefined || s.length == 0) {
			writeln();
		} else {
			writeln("\t"+s);
		}
	};
}

export class CodeGen {
	indented : CodeGen | undefined;

	constructor(public writeln: (s?: string) => void) {
		this.indented = undefined;
	}

	rawScope<R>(f: (newCodeGen: CodeGen) => R) : R {
		if (this.indented === undefined) {
			this.indented = new CodeGen(indentAdder(this.writeln));
		}
		return f(this.indented);
	}

	scope<R>(openingLine: string, f: (newCodeGen: CodeGen) => R) : R {
		this.writeln(openingLine);
		let ret = this.rawScope(f);
		this.writeln("}");
		return ret;
	}
}