import FluentError from "./error.js";

let isStickyRegexpSupported = false;
try {
  new RegExp(".", "y");
  isStickyRegexpSupported = true;
// eslint-disable-next-line no-empty
} catch (_) {}

/**
 * Weak "sticky" RegExp polyfill. Given a RegExp re, return an object that
 * implements only the following properties of the "stickiy" regexp that would
 * be obtained by `new RegExp(re.source, 'y')`:
 *
 * - RegExp.prototype.test()
 * - RegExp.prototype.exec()
 * - RegExp.lastIndex
 *
 * @param {*} re
 */
function sticky(original) {
  if (isStickyRegexpSupported) {
    return new RegExp(original.source, "y");
  }

  if (original.source[0] === "^") {
    throw new Error("Sticky RegExp with ^ not implemented.");
  }
  // Create a new regexp that matches only at the beginning of the string. We'll
  // use to mimick "sticky" behavior by executing it against the input sliced at
  // `lastIndex`
  const re = new RegExp(`^${original.source}`);
  const wrapped = {
    test(str) {
      return !!this.exec(str);
    },
    exec(str) {
      const result = re.exec(str.slice(this.lastIndex));
      if (result) {
        this.lastIndex += result[0].length;
      } else {
        this.lastIndex = 0;
      }
      return result;
    },
    lastIndex: 0,
    original: original
  };
  return wrapped;
}

// This regex is used to iterate through the beginnings of messages and terms.
// With the /m flag, the ^ matches at the beginning of every line.
const RE_MESSAGE_START = /^(-?[a-zA-Z][\w-]*) *= */mg;

// Both Attributes and Variants are parsed in while loops. These regexes are
// used to break out of them.
const STICKY_RE_ATTRIBUTE_START = sticky(/\.([a-zA-Z][\w-]*) *= */);
const STICKY_RE_VARIANT_START = sticky(/\*?\[/);

const STICKY_RE_NUMBER_LITERAL = sticky(/(-?[0-9]+(?:\.([0-9]+))?)/);
const STICKY_RE_IDENTIFIER = sticky(/([a-zA-Z][\w-]*)/);
const STICKY_RE_REFERENCE = sticky(
  /([$-])?([a-zA-Z][\w-]*)(?:\.([a-zA-Z][\w-]*))?/
);
const RE_FUNCTION_NAME = /^[A-Z][A-Z0-9_-]*$/;

// A "run" is a sequence of text or string literal characters which don't
// require any special handling. For TextElements such special characters are: {
// (starts a placeable), and line breaks which require additional logic to check
// if the next line is indented. For StringLiterals they are: \ (starts an
// escape sequence), " (ends the literal), and line breaks which are not allowed
// in StringLiterals. Note that string runs may be empty; text runs may not.
const STICKY_RE_TEXT_RUN = sticky(/([^{}\n\r]+)/);
const STICKY_RE_STRING_RUN = sticky(/([^\\"\n\r]*)/);

// Escape sequences.
const STICKY_RE_STRING_ESCAPE = sticky(/\\([\\"])/);
const STICKY_RE_UNICODE_ESCAPE = sticky(
  /\\u([a-fA-F0-9]{4})|\\U([a-fA-F0-9]{6})/
);

// Used for trimming TextElements and indents.
const RE_LEADING_NEWLINES = /^\n+/;
const RE_TRAILING_SPACES = / +$/;
// Used in makeIndent to strip spaces from blank lines and normalize CRLF to LF.
const RE_BLANK_LINES = / *\r?\n/g;
// Used in makeIndent to measure the indentation.
const RE_INDENT = /( *)$/;

// Common tokens.
const STICKY_TOKEN_BRACE_OPEN = sticky(/{\s*/);
const STICKY_TOKEN_BRACE_CLOSE = sticky(/\s*}/);
const STICKY_TOKEN_BRACKET_OPEN = sticky(/\[\s*/);
const STICKY_TOKEN_BRACKET_CLOSE = sticky(/\s*] */);
const STICKY_TOKEN_PAREN_OPEN = sticky(/\s*\(\s*/);
const STICKY_TOKEN_ARROW = sticky(/\s*->\s*/);
const STICKY_TOKEN_COLON = sticky(/\s*:\s*/);
// Note the optional comma. As a deviation from the Fluent EBNF, the parser
// doesn't enforce commas between call arguments.
const STICKY_TOKEN_COMMA = sticky(/\s*,?\s*/);
const STICKY_TOKEN_BLANK = sticky(/\s+/);

// Maximum number of placeables in a single Pattern to protect against Quadratic
// Blowup attacks. See https://msdn.microsoft.com/en-us/magazine/ee335713.aspx.
const MAX_PLACEABLES = 100;

/**
 * Fluent Resource is a structure storing parsed localization entries.
 */
export default class FluentResource {
  constructor(source) {
    this.body = this._parse(source);
  }

  _parse(source) {
    RE_MESSAGE_START.lastIndex = 0;

    let resource = [];
    let cursor = 0;

    // Iterate over the beginnings of messages and terms to efficiently skip
    // comments and recover from errors.
    while (true) {
      let next = RE_MESSAGE_START.exec(source);
      if (next === null) {
        break;
      }

      cursor = RE_MESSAGE_START.lastIndex;
      try {
        resource.push(parseMessage(next[1]));
      } catch (err) {
        if (err instanceof FluentError) {
          // Don't report any Fluent syntax errors. Skip directly to the
          // beginning of the next message or term.
          continue;
        }
        throw err;
      }
    }

    return resource;

    // The parser implementation is inlined below for performance reasons,
    // as well as for convenience of accessing `source` and `cursor`.

    // The parser focuses on minimizing the number of false negatives at the
    // expense of increasing the risk of false positives. In other words, it
    // aims at parsing valid Fluent messages with a success rate of 100%, but it
    // may also parse a few invalid messages which the reference parser would
    // reject. The parser doesn't perform any validation and may produce entries
    // which wouldn't make sense in the real world. For best results users are
    // advised to validate translations with the fluent-syntax parser
    // pre-runtime.

    // The parser makes an extensive use of sticky regexes which can be anchored
    // to any offset of the source string without slicing it. Errors are thrown
    // to bail out of parsing of ill-formed messages.

    function test(re) {
      re.lastIndex = cursor;
      return re.test(source);
    }

    // Advance the cursor by the char if it matches. May be used as a predicate
    // (was the match found?) or, if errorClass is passed, as an assertion.
    function consumeChar(char, errorClass) {
      if (source[cursor] === char) {
        cursor++;
        return true;
      }
      if (errorClass) {
        throw new errorClass(`Expected ${char}`);
      }
      return false;
    }

    // Advance the cursor by the token if it matches. May be used as a predicate
    // (was the match found?) or, if errorClass is passed, as an assertion.
    function consumeToken(re, errorClass) {
      if (test(re)) {
        cursor = re.lastIndex;
        return true;
      }
      if (errorClass) {
        throw new errorClass(`Expected ${re.toString()}`);
      }
      return false;
    }

    // Execute a regex, advance the cursor, and return all capture groups.
    function match(re) {
      re.lastIndex = cursor;
      let result = re.exec(source);
      if (result === null) {
        throw new FluentError(`Expected ${re.toString()}`);
      }
      cursor = re.lastIndex;
      return result;
    }

    // Execute a regex, advance the cursor, and return the capture group.
    function match1(re) {
      return match(re)[1];
    }

    function parseMessage(id) {
      let value = parsePattern();
      let attributes = parseAttributes();

      if (value === null && Object.keys(attributes).length === 0) {
        throw new FluentError("Expected message value or attributes");
      }

      return {id, value, attributes};
    }

    function parseAttributes() {
      let attrs = Object.create(null);

      while (test(STICKY_RE_ATTRIBUTE_START)) {
        let name = match1(STICKY_RE_ATTRIBUTE_START);
        let value = parsePattern();
        if (value === null) {
          throw new FluentError("Expected attribute value");
        }
        attrs[name] = value;
      }

      return attrs;
    }

    function parsePattern() {
      // First try to parse any simple text on the same line as the id.
      if (test(STICKY_RE_TEXT_RUN)) {
        var first = match1(STICKY_RE_TEXT_RUN);
      }

      // If there's a placeable on the first line, parse a complex pattern.
      if (source[cursor] === "{" || source[cursor] === "}") {
        // Re-use the text parsed above, if possible.
        return parsePatternElements(first ? [first] : [], Infinity);
      }

      // RE_TEXT_VALUE stops at newlines. Only continue parsing the pattern if
      // what comes after the newline is indented.
      let indent = parseIndent();
      if (indent) {
        if (first) {
          // If there's text on the first line, the blank block is part of the
          // translation content in its entirety.
          return parsePatternElements([first, indent], indent.length);
        }
        // Otherwise, we're dealing with a block pattern, i.e. a pattern which
        // starts on a new line. Discrad the leading newlines but keep the
        // inline indent; it will be used by the dedentation logic.
        indent.value = trim(indent.value, RE_LEADING_NEWLINES);
        return parsePatternElements([indent], indent.length);
      }

      if (first) {
        // It was just a simple inline text after all.
        return trim(first, RE_TRAILING_SPACES);
      }

      return null;
    }

    // Parse a complex pattern as an array of elements.
    function parsePatternElements(elements = [], commonIndent) {
      let placeableCount = 0;

      while (true) {
        if (test(STICKY_RE_TEXT_RUN)) {
          elements.push(match1(STICKY_RE_TEXT_RUN));
          continue;
        }

        if (source[cursor] === "{") {
          if (++placeableCount > MAX_PLACEABLES) {
            throw new FluentError("Too many placeables");
          }
          elements.push(parsePlaceable());
          continue;
        }

        if (source[cursor] === "}") {
          throw new FluentError("Unbalanced closing brace");
        }

        let indent = parseIndent();
        if (indent) {
          elements.push(indent);
          commonIndent = Math.min(commonIndent, indent.length);
          continue;
        }

        break;
      }

      let lastIndex = elements.length - 1;
      // Trim the trailing spaces in the last element if it's a TextElement.
      if (typeof elements[lastIndex] === "string") {
        elements[lastIndex] = trim(elements[lastIndex], RE_TRAILING_SPACES);
      }

      let baked = [];
      for (let element of elements) {
        if (element.type === "indent") {
          // Dedent indented lines by the maximum common indent.
          element = element.value.slice(0, element.value.length - commonIndent);
        }
        if (element) {
          baked.push(element);
        }
      }
      return baked;
    }

    function parsePlaceable() {
      consumeToken(STICKY_TOKEN_BRACE_OPEN, FluentError);

      let selector = parseInlineExpression();
      if (consumeToken(STICKY_TOKEN_BRACE_CLOSE)) {
        return selector;
      }

      if (consumeToken(STICKY_TOKEN_ARROW)) {
        let variants = parseVariants();
        consumeToken(STICKY_TOKEN_BRACE_CLOSE, FluentError);
        return {type: "select", selector, ...variants};
      }

      throw new FluentError("Unclosed placeable");
    }

    function parseInlineExpression() {
      if (source[cursor] === "{") {
        // It's a nested placeable.
        return parsePlaceable();
      }

      if (test(STICKY_RE_REFERENCE)) {
        let [, sigil, name, attr = null] = match(STICKY_RE_REFERENCE);

        if (sigil === "$") {
          return {type: "var", name};
        }

        if (consumeToken(STICKY_TOKEN_PAREN_OPEN)) {
          let args = parseArguments();

          if (sigil === "-") {
            // A parameterized term: -term(...).
            return {type: "term", name, attr, args};
          }

          if (RE_FUNCTION_NAME.test(name)) {
            return {type: "func", name, args};
          }

          throw new FluentError("Function names must be all upper-case");
        }

        if (sigil === "-") {
          // A non-parameterized term: -term.
          return {type: "term", name, attr, args: []};
        }

        return {type: "mesg", name, attr};
      }

      return parseLiteral();
    }

    function parseArguments() {
      let args = [];
      while (true) {
        switch (source[cursor]) {
          case ")": // End of the argument list.
            cursor++;
            return args;
          case undefined: // EOF
            throw new FluentError("Unclosed argument list");
        }

        args.push(parseArgument());
        // Commas between arguments are treated as whitespace.
        consumeToken(STICKY_TOKEN_COMMA);
      }
    }

    function parseArgument() {
      let expr = parseInlineExpression();
      if (expr.type !== "mesg") {
        return expr;
      }

      if (consumeToken(STICKY_TOKEN_COLON)) {
        // The reference is the beginning of a named argument.
        return {type: "narg", name: expr.name, value: parseLiteral()};
      }

      // It's a regular message reference.
      return expr;
    }

    function parseVariants() {
      let variants = [];
      let count = 0;
      let star;

      while (test(STICKY_RE_VARIANT_START)) {
        if (consumeChar("*")) {
          star = count;
        }

        let key = parseVariantKey();
        let value = parsePattern();
        if (value === null) {
          throw new FluentError("Expected variant value");
        }
        variants[count++] = {key, value};
      }

      if (count === 0) {
        return null;
      }

      if (star === undefined) {
        throw new FluentError("Expected default variant");
      }

      return {variants, star};
    }

    function parseVariantKey() {
      consumeToken(STICKY_TOKEN_BRACKET_OPEN, FluentError);
      let key = test(STICKY_RE_NUMBER_LITERAL)
        ? parseNumberLiteral()
        : {type: "str", value: match1(STICKY_RE_IDENTIFIER)};
      consumeToken(STICKY_TOKEN_BRACKET_CLOSE, FluentError);
      return key;
    }

    function parseLiteral() {
      if (test(STICKY_RE_NUMBER_LITERAL)) {
        return parseNumberLiteral();
      }

      if (source[cursor] === "\"") {
        return parseStringLiteral();
      }

      throw new FluentError("Invalid expression");
    }

    function parseNumberLiteral() {
      let [, value, fraction = ""] = match(STICKY_RE_NUMBER_LITERAL);
      let precision = fraction.length;
      return {type: "num", value: parseFloat(value), precision};
    }

    function parseStringLiteral() {
      consumeChar("\"", FluentError);
      let value = "";
      while (true) {
        value += match1(STICKY_RE_STRING_RUN);

        if (source[cursor] === "\\") {
          value += parseEscapeSequence();
          continue;
        }

        if (consumeChar("\"")) {
          return {type: "str", value};
        }

        // We've reached an EOL of EOF.
        throw new FluentError("Unclosed string literal");
      }
    }

    // Unescape known escape sequences.
    function parseEscapeSequence() {
      if (test(STICKY_RE_STRING_ESCAPE)) {
        return match1(STICKY_RE_STRING_ESCAPE);
      }

      if (test(STICKY_RE_UNICODE_ESCAPE)) {
        let [, codepoint4, codepoint6] = match(STICKY_RE_UNICODE_ESCAPE);
        let codepoint = parseInt(codepoint4 || codepoint6, 16);
        return codepoint <= 0xD7FF || 0xE000 <= codepoint
          // It's a Unicode scalar value.
          ? String.fromCodePoint(codepoint)
          // Lonely surrogates can cause trouble when the parsing result is
          // saved using UTF-8. Use U+FFFD REPLACEMENT CHARACTER instead.
          : "�";
      }

      throw new FluentError("Unknown escape sequence");
    }

    // Parse blank space. Return it if it looks like indent before a pattern
    // line. Skip it othwerwise.
    function parseIndent() {
      let start = cursor;
      consumeToken(STICKY_TOKEN_BLANK);

      // Check the first non-blank character after the indent.
      switch (source[cursor]) {
        case ".":
        case "[":
        case "*":
        case "}":
        case undefined: // EOF
          // A special character. End the Pattern.
          return false;
        case "{":
          // Placeables don't require indentation (in EBNF: block-placeable).
          // Continue the Pattern.
          return makeIndent(source.slice(start, cursor));
      }

      // If the first character on the line is not one of the special characters
      // listed above, it's a regular text character. Check if there's at least
      // one space of indent before it.
      if (source[cursor - 1] === " ") {
        // It's an indented text character (in EBNF: indented-char). Continue
        // the Pattern.
        return makeIndent(source.slice(start, cursor));
      }

      // A not-indented text character is likely the identifier of the next
      // message. End the Pattern.
      return false;
    }

    // Trim blanks in text according to the given regex.
    function trim(text, re) {
      return text.replace(re, "");
    }

    // Normalize a blank block and extract the indent details.
    function makeIndent(blank) {
      let value = blank.replace(RE_BLANK_LINES, "\n");
      let length = RE_INDENT.exec(blank)[1].length;
      return {type: "indent", value, length};
    }
  }
}
