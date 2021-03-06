/*  An operational transformation library for atomic values. This
	library provides three operations: NO_OP (an operation that
	does nothing), SET (replace the document with a new value), and
	MATH (apply a function to the document). These functions are generic
	over various sorts of data types that they may apply to.

	new values.NO_OP()

	This operation does nothing. It is the return value of various
	functions throughout the library, e.g. when operations cancel
	out. NO_OP is conflictless: It never creates a conflict when
	rebased against or operations or when other operations are
	rebased against it.
	

	new values.SET(new_value)
	
	The atomic replacement of one value with another. Works for
	any data type. Supports a conflictless rebase with other SET
	and MATH operations.
	

	new values.MATH(operator, operand)
	
	Applies a commutative arithmetic function to a number.
	
	"add": addition (use a negative number to decrement)
	
	"mult": multiplication (use the reciprocal to divide)
	
	"rot": addition followed by modulus (the operand is given
	       as a tuple of the increment and the modulus). The document
	       object must be non-negative and less than the modulus.

	"xor": bitwise exclusive-or (over integers and booleans
	       only)
	
	Note that by commutative we mean that the operation is commutative
	under composition, i.e. add(1)+add(2) == add(2)+add(1).

	MATH supports a conflictless rebase with other MATH and SET operations.
	
	*/
	
var util = require('util');
var deepEqual = require("deep-equal");
var jot = require("./index.js");
var MISSING = require("./objects.js").MISSING;

//////////////////////////////////////////////////////////////////////////////

exports.module_name = 'values'; // for serialization/deserialization

exports.NO_OP = function() {
	/* An operation that makes no change to the document. */
	Object.freeze(this);
}
exports.NO_OP.prototype = Object.create(jot.BaseOperation.prototype); // inherit
jot.add_op(exports.NO_OP, exports, 'NO_OP', []);

exports.SET = function(new_value) {
	/* An operation that replaces the document with a new (atomic) value. */
	this.new_value = new_value;
	Object.freeze(this);
}
exports.SET.prototype = Object.create(jot.BaseOperation.prototype); // inherit
jot.add_op(exports.SET, exports, 'SET', ['new_value']);

exports.MATH = function(operator, operand) {
	/* An operation that applies addition, multiplication, or rotation (modulus addition)
	   to a numeric document. */
	this.operator = operator;
	this.operand = operand;
	Object.freeze(this);
}
exports.MATH.prototype = Object.create(jot.BaseOperation.prototype); // inherit
jot.add_op(exports.MATH, exports, 'MATH', ['operator', 'operand']);


//////////////////////////////////////////////////////////////////////////////

exports.NO_OP.prototype.inspect = function(depth) {
	return "<values.NO_OP>"
}

exports.NO_OP.prototype.apply = function (document) {
	/* Applies the operation to a document. Returns the document
	   unchanged. */
	return document;
}

exports.NO_OP.prototype.simplify = function () {
	/* Returns a new atomic operation that is a simpler version
	   of this operation.*/
	return this;
}

exports.NO_OP.prototype.inverse = function (document) {
	/* Returns a new atomic operation that is the inverse of this operation,
	given the state of the document before the operation applies. */
	return this;
}

exports.NO_OP.prototype.atomic_compose = function (other) {
	/* Creates a new atomic operation that has the same result as this
	   and other applied in sequence (this first, other after). Returns
	   null if no atomic operation is possible. */
	return other;
}

exports.NO_OP.prototype.get_length_change = function (old_length) {
	// Support routine for sequences.PATCH that returns the change in
	// length to a sequence if this operation is applied to it.
	return 0;
}

exports.NO_OP.prototype.decompose_right = function (at_old_index, at_new_index) {
	// Support routine for sequences.PATCH.
	return [this, this];
}

//////////////////////////////////////////////////////////////////////////////

exports.SET.prototype.inspect = function(depth) {
	function str(v) {
		// Render the special MISSING value from objects.js
		// not as a JSON object.
		if (v === MISSING)
			return "~";

		// Render any other value as a JSON string.
		return util.format("%j", v);
	}
	return util.format("<values.SET %s>", str(this.new_value));
}

exports.SET.prototype.apply = function (document) {
	/* Applies the operation to a document. Returns the new
	   value, regardless of the document. */
	return this.new_value;
}

exports.SET.prototype.simplify = function () {
	/* Returns a new atomic operation that is a simpler version
	   of another operation. If the new value is the same as the
	   old value, returns NO_OP. */
	return this;
}

exports.SET.prototype.inverse = function (document) {
	/* Returns a new atomic operation that is the inverse of this operation,
	   given the state of the document before this operation applies. */
	return new exports.SET(document);
}

exports.SET.prototype.atomic_compose = function (other) {
	/* Creates a new atomic operation that has the same result as this
	   and other applied in sequence (this first, other after). Returns
	   null if no atomic operation is possible.
	   Returns a new SET operation that simply sets the value to what
	   the value would be when the two operations are composed. */
	return new exports.SET(other.apply(this.new_value)).simplify();
}

exports.SET.prototype.rebase_functions = [
	// Rebase this against other and other against this.

	[exports.SET, function(other, conflictless) {
		// SET and SET.

		// If they both set the the document to the same value, then the one
		// applied second (the one being rebased) becomes a no-op. Since the
		// two parts of the return value are for each rebased against the
		// other, both are returned as no-ops.
		if (deepEqual(this.new_value, other.new_value, { strict: true }))
			return [new exports.NO_OP(), new exports.NO_OP()];
		
		// If they set the document to different values and conflictless is
		// true, then we clobber the one whose value has a lower sort order.
		if (conflictless && jot.cmp(this.new_value, other.new_value) < 0)
			return [new exports.NO_OP(), new exports.SET(other.new_value)];

		// cmp > 0 is handled by a call to this function with the arguments
		// reversed, so we don't need to explicltly code that logic.

		// If conflictless is false, then we can't rebase the operations
		// because we can't preserve the meaning of both. Return null to
		// signal conflict.
		return null;
	}],

	[exports.MATH, function(other, conflictless) {
		// SET (this) and MATH (other). To get a consistent effect no matter
		// which order the operations are applied in, we say the SET comes
		// first and the MATH second. But since MATH only works for numeric
		// types, this isn't always possible.

		// To get the logical effect of applying MATH second (even though it's
		// the SET being rebased, meaning it will be composed second), we
		// apply the MATH operation to its new value.
		try {
			// If the data types make this possible...
			return [
				new exports.SET(other.apply(this.new_value)),
				other // no change is needed when it is the MATH being rebased
				];
		} catch (e) {
			// Data type mismatch, e.g. the SET sets the value to a string and
			// so the MATH operation can't be applied. In this case, we simply
			// always prefer the SET if we're asked for a conflictless rebase.
			// The MATH becomes a no-op.
			if (conflictless)
				return [
					new exports.SET(this.new_value),
					new exports.NO_OP()
					];
		}

		// Can't resolve conflict.
		return null;
	}]
];

exports.SET.prototype.get_length_change = function (old_length) {
	// Support routine for sequences.PATCH that returns the change in
	// length to a sequence if this operation is applied to it.
	if (typeof this.new_value == "string" || Array.isArray(this.new_value))
		return this.new_value.length - old_length;
	throw "not applicable";
}

exports.SET.prototype.decompose_right = function (at_new_index) {
	// Support routine for sequences.PATCH that returns a decomposition
	// of the operation (over a sequence-like object) that splits it
	// at the given index in the new value.
	if (typeof this.new_value == "string" || Array.isArray(this.new_value))
		return [
			new exports.SET(this.new_value.slice(0, at_new_index)),
			new exports.SET(this.new_value.slice(at_new_index))
		];
	return null;
}

//////////////////////////////////////////////////////////////////////////////

exports.MATH.prototype.inspect = function(depth) {
	return util.format("<values.MATH %s:%j>", this.operator, this.operand);
}

exports.MATH.prototype.apply = function (document) {
	/* Applies the operation to this.operand. Applies the operator/operand
	   as a function to the document. */
	if (typeof document != "number" && typeof document != "boolean")
		throw "Invalid operation on non-numeric document."
	if (this.operator == "add")
		return document + this.operand;
	if (this.operator == "rot")
		return (document + this.operand[0]) % this.operand[1];
	if (this.operator == "mult")
		return document * this.operand;
	if (this.operator == "xor") {
		var ret = document ^ this.operand;
		if (typeof document == 'boolean')
			ret = !!ret; // cast to boolean
		return ret;
	}
}

exports.MATH.prototype.simplify = function () {
	/* Returns a new atomic operation that is a simpler version
	   of another operation. If the operation is a degenerate case,
	   return NO_OP. */
	if (this.operator == "add" && this.operand == 0)
		return new exports.NO_OP();
	if (this.operator == "rot" && this.operand[0] == 0)
		return new exports.NO_OP();
	if (this.operator == "rot") // ensure the first value is less than the modulus
		return new exports.MATH("rot", [this.operand[0] % this.operand[1], this.operand[1]]);
	if (this.operator == "mult" && this.operand == 1)
		return new exports.NO_OP();
	if (this.operator == "xor" && this.operand == 0)
		return new exports.NO_OP();
	return this;
}

exports.MATH.prototype.inverse = function (document) {
	/* Returns a new atomic operation that is the inverse of this operation,
	given the state of the document before the operation applies. */
	// The document itself doesn't matter.
	return this.invert();
}

exports.MATH.prototype.invert = function () {
	if (this.operator == "add")
		return new exports.MATH("add", -this.operand);
	if (this.operator == "rot")
		return new exports.MATH("rot", [-this.operand[0], this.operand[1]]);
	if (this.operator == "mult")
		return new exports.MATH("mult", 1.0/this.operand);
	if (this.operator == "xor")
		return this; // is its own inverse
}

exports.MATH.prototype.atomic_compose = function (other) {
	/* Creates a new atomic operation that has the same result as this
	   and other applied in sequence (this first, other after). Returns
	   null if no atomic operation is possible. */

	if (other instanceof exports.MATH) {
		// two adds just add the operands
		if (this.operator == other.operator && this.operator == "add")
			return new exports.MATH("add", this.operand + other.operand).simplify();

		// two rots with the same modulus add the operands
		if (this.operator == other.operator && this.operator == "rot" && this.operand[1] == other.operand[1])
			return new exports.MATH("rot", [this.operand[0] + other.operand[0], this.operand[1]]).simplify();

		// two multiplications multiply the operands
		if (this.operator == other.operator && this.operator == "mult")
			return new exports.MATH("mult", this.operand * other.operand).simplify();

		// two xor's xor the operands
		if (this.operator == other.operator && this.operator == "xor")
			return new exports.MATH("xor", this.operand ^ other.operand).simplify();
	}
	
	return null; // no composition is possible
}

exports.MATH.prototype.rebase_functions = [
	// Rebase this against other and other against this.

	[exports.MATH, function(other, conflictless) {
		// Since the map operators are commutative, it doesn't matter which order
		// they are applied in. That makes the rebase trivial -- if the operators
		// are the same, then nothing needs to be done.
		if (this.operator == other.operator) {
			// rot must have same modulus
			if (this.operator != "rot" || this.operand[1] == other.operand[1])
				return [this, other];
		}

		// If we are given two operators, then we don't know which order they
		// should be applied in. In a conflictless rebase, we can choose on
		// arbitrarily (but predictably). They all operate over numbers so they
		// can be applied in either order, it's just that the resulting value
		// will depend on the order. We sort on both operator and operand because
		// in a rot the operand contains information that distinguishes them.
		if (conflictless) {
			// The one with the lower sort order applies last. So if this has
			// a lower sort order, then when rebasing this we don't make a
			// change. But when rebasing other, we have to undo this, then
			// apply other, then apply this again.
			if (jot.cmp([this.operator, this.operand], [other.operator, other.operand]) < 0) {
				return [
					this,
					jot.LIST([this.invert(), other, this])
				];
			}

			// if cmp == 0, then the operators were the same and we handled
			// it above. if cmp > 0 then we handle this on the call to
			// other.rebase(this).

		}

		return null;
	}]
];

exports.createRandomOp = function(doc, context) {
	// Create a random operation that could apply to doc.
	// Choose uniformly across various options depending on
	// the data type of doc.
	var ops = [];

	// NO_OP is always a possibility.
	ops.push(function() { return new exports.NO_OP() });

	// An identity SET is always a possibility.
	ops.push(function() { return new exports.SET(doc) });

	// Set to null, unless in splice contexts
	if (context != "string-character" && context != "string")
		ops.push(function() { return new exports.SET(null) });

	// Clear the key, if we're in an object.
	if (context == "object")
		ops.push(function() { return new exports.SET(MISSING) });

	// Set to another value of the same type.
	if (typeof doc === "boolean")
		ops.push(function() { return new exports.SET(!doc) });
	if (typeof doc === "number")
		ops.push(function() { return new exports.SET(doc + 50) });
	if (typeof doc === "number")
		ops.push(function() { return new exports.SET(doc / 2.1) });

	if (typeof doc === "string" || Array.isArray(doc)) {
		if (context != "string-character") {
			// Delete (if not already empty).
			if (doc.length > 0)
				ops.push(function() { return new exports.SET(doc.slice(0, 0)) });

			if (doc.length >= 1) {
				// shorten at start
				ops.push(function() { return new exports.SET(doc.slice(Math.floor(Math.random()*(doc.length-1)), doc.length)) });

				// shorten at end
				ops.push(function() { return new exports.SET(doc.slice(0, Math.floor(Math.random()*(doc.length-1)))) });
			}

			if (doc.length >= 2) {
				// shorten by on both sides
				var a = Math.floor(Math.random()*doc.length-1);
				var b = Math.floor(Math.random()*(doc.length-a));
				ops.push(function() { return new exports.SET(doc.slice(a, a+b)) });
			}

			if (doc.length > 0) {
				// expand by copying existing elements from document

				function concat2(item1, item2) {
					if (item1 instanceof String)
						return item1 + item2;
					return item1.concat(item2);
				}
				function concat3(item1, item2, item3) {
					if (item1 instanceof String)
						return item1 + item2 + item3;
					return item1.concat(item2).concat(item3);
				}
			
				// expand by elements at start
				ops.push(function() { return new exports.SET(concat2(doc.slice(0, 1+Math.floor(Math.random()*(doc.length-1))), doc)) });
				// expand by elements at end
				ops.push(function() { return new exports.SET(concat2(doc, doc.slice(0, 1+Math.floor(Math.random()*(doc.length-1))))); });
				// expand by elements on both sides
				ops.push(function() { return new exports.SET(concat3(doc.slice(0, 1+Math.floor(Math.random()*(doc.length-1))), doc, doc.slice(0, 1+Math.floor(Math.random()*(doc.length-1))))); });
			} else {
				// expand by generating new elements
				if (typeof doc === "string")
					ops.push(function() { return new exports.SET((Math.random()+"").slice(2)); });
				else if (Array.isArray(doc))
					ops.push(function() { return new exports.SET([null,null,null].map(function() { return Math.random() })); });
			}
		}

		// reverse
		if (doc != doc.split("").reverse().join(""))
			ops.push(function() { return new exports.SET(doc.split("").reverse().join("")); });

		// replace with new elements of the same length
		if (doc.length > 0 && typeof doc === "string") {
			var newvalue = "";
			for (var i = 0; i < doc.length; i++)
				newvalue += (Math.random()+"").slice(2, 3);
			ops.push(function() { return new exports.SET(newvalue); });
		}
	}

	// Math
	if (typeof doc === "number") {
		ops.push(function() { return new exports.MATH("add", 2.5); })
		ops.push(function() { return new exports.MATH("rot", [1, 13]); })
		ops.push(function() { return new exports.MATH("mult", .75); })
		ops.push(function() { return new exports.MATH("xor", 0xFF); })

	}

	// Select randomly.
	return ops[Math.floor(Math.random() * ops.length)]();
}
