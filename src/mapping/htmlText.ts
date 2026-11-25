// The text of an HTML part as a reader sees it, for searching.

// &nbsp; to &yuml; are U+00A0 to U+00FF, in this order.
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const NAMED = new Map<string, string>([
  ...LATIN1.split(" ").map((name, i) => [name, String.fromCharCode(160 + i)] as const),
  ...Object.entries({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", euro: "€", ndash: "–", mdash: "—", hellip: "…",
    lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", lsaquo: "‹", rsaquo: "›",
    bull: "•", trade: "™", scaron: "š", Scaron: "Š", OElig: "Œ", oelig: "œ", zwj: "‍", zwnj: "‌", ensp: " ", emsp: " ", thinsp: " ",
  }),
]);

function decodeEntity(all: string, ref: string): string {
  if (ref[0] !== "#") return NAMED.get(ref) ?? all;
  const code = /^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
}

// Elements that end a word; any other tag may stand within one.
const BLOCK =
  /<\/?(?:address|article|aside|blockquote|body|br|caption|center|dd|div|dl|dt|fieldset|figure|footer|form|h[1-6]|header|hr|html|img|input|li|main|nav|ol|option|p|pre|section|select|table|tbody|td|tfoot|th|thead|title|tr|ul)\b[^>]*>/gi;

export function htmlToSearchText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(BLOCK, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, decodeEntity);
}
