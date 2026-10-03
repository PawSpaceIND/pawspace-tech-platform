/** Deliberately restricted scan profile: one classic xref, flat indirect objects,
 * no encryption, incremental revisions, object streams, actions, forms or attachments.
 * Unsupported PDFs are refused, never repaired or flattened (which could invalidate signatures).
 * This is a bounded structural validator, not a malware scanner or signature verifier. */
export const PDF_LIMITS = { bytes: 512 * 1024, pages: 40, objects: 2048, depth: 32, inflatedStream: 4 * 1024 * 1024, inflatedTotal: 12 * 1024 * 1024, imagePixels: 20_000_000, entityStoredBytes: 8 * 1024 * 1024 };
type Name = { name: string }; type Ref = { id: number; generation: number }; type Literal = { literal: string };
type Value = number | boolean | null | Name | Ref | Literal | Value[] | Dict;
type Dict = { dict: { [key: string]: Value } };
const refuse = (reason: string): never => { throw new Error(`invalid_pdf_${reason}`); };
const isRef = (value: Value | undefined): value is Ref => !!value && typeof value === 'object' && 'id' in value;
const isDict = (value: Value | undefined): value is Dict => !!value && typeof value === 'object' && !Array.isArray(value) && 'dict' in value;
const named = (value: Value | undefined) => value && typeof value === 'object' && 'name' in value ? value.name : '';
const forbidden = new Set(['Encrypt', 'ObjStm', 'XRef', 'XRefStm', 'Prev', 'AcroForm', 'OpenAction', 'AA', 'A', 'JS', 'JavaScript', 'RichMedia', 'EmbeddedFiles', 'EmbeddedFile', 'Filespec', 'URI', 'Launch', 'SubmitForm', 'GoToR', 'GoToE', 'Names', 'Annots', '3D', 'Movie', 'Sound', 'Screen', 'Rendition', 'PostScript', 'OCProperties']);
function binaryText(bytes: Uint8Array) { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return text; }
class Parser {
  raw: string; position = 0; tokens = 0;
  constructor(raw: string) { this.raw = raw; }
  skip() { for (;;) { const match = /^(?:[\x00\t\n\f\r ]+|%[^\r\n]*(?:\r\n|\r|\n|$))/.exec(this.raw.slice(this.position)); if (!match) break; this.position += match[0].length; } }
  value(depth = 0): Value {
    if (depth > PDF_LIMITS.depth || ++this.tokens > 20_000) return refuse('complexity'); this.skip();
    const rest = this.raw.slice(this.position);
    if (rest.startsWith('<<')) {
      this.position += 2; const result: Record<string, Value> = Object.create(null);
      for (;;) { this.skip(); if (this.raw.startsWith('>>', this.position)) { this.position += 2; return { dict: result }; }
        const key = this.value(depth + 1); if (!key || typeof key !== 'object' || !('name' in key)) return refuse('dictionary_key');
        if (Object.hasOwn(result, key.name)) return refuse('duplicate_key'); result[key.name] = this.value(depth + 1);
      }
    }
    if (rest[0] === '[') { this.position++; const result: Value[] = []; for (;;) { this.skip(); if (this.raw[this.position] === ']') { this.position++; return result; } result.push(this.value(depth + 1)); } }
    if (rest[0] === '/') {
      const match = /^\/([^\x00\t\n\f\r ()<>\[\]{}/%]+)/.exec(rest); if (!match) return refuse('name'); this.position += match[0].length;
      if (/#(?![0-9a-fA-F]{2})/.test(match[1])) return refuse('name_escape');
      const name = match[1].replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (forbidden.has(name)) return refuse('active_or_unsupported_content'); return { name };
    }
    if (rest[0] === '(') {
      let level = 1; this.position++;
      while (level && this.position < this.raw.length) { const char = this.raw[this.position++]; if (char === '\\') { this.position++; continue; } if (char === '(') level++; if (char === ')') level--; if (level > PDF_LIMITS.depth) return refuse('string_depth'); }
      if (level) return refuse('literal'); return { literal: '' };
    }
    if (rest[0] === '<') { const match = /^<([\da-fA-F\s]*)>/.exec(rest); if (!match) return refuse('hex_string'); this.position += match[0].length; return { literal: '' }; }
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(rest);
    if (number) { this.position += number[0].length; const value = Number(number[0]);
      const reference = /^\s+(\d+)\s+R\b/.exec(this.raw.slice(this.position));
      if (reference && Number.isInteger(value) && value >= 0) { this.position += reference[0].length; return { id: value, generation: Number(reference[1]) }; }
      if (!Number.isFinite(value)) return refuse('number'); return value;
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) if (rest.startsWith(word) && /[\s\]>/]|^$/.test(rest.slice(word.length, word.length + 1))) { this.position += word.length; return value; }
    return refuse('syntax');
  }
}
export async function inspectPdf(bytes: Uint8Array) {
  if (bytes.length < 40 || bytes.length > PDF_LIMITS.bytes) return refuse('size');
  const raw = binaryText(bytes);
  if (!/^%PDF-1\.[0-7](?:\r\n|\r|\n)/.test(raw)) return refuse('header');
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(raw); if (!tail) return refuse('trailer');
  const xrefOffset = Number(tail[1]); if (!raw.startsWith('xref', xrefOffset)) return refuse('classic_xref_required');
  const xref = new Parser(raw.slice(xrefOffset + 4)), offsets = new Map<number, { offset: number; generation: number }>();
  const entries = new Set<number>();
  for (;;) {
    xref.skip(); if (xref.raw.startsWith('trailer', xref.position)) { xref.position += 7; break; }
    const section = /^(\d+)\s+(\d+)\s*/.exec(xref.raw.slice(xref.position)); if (!section) return refuse('xref_section');
    xref.position += section[0].length; const first = Number(section[1]), count = Number(section[2]);
    if (first + count > PDF_LIMITS.objects || count < 1) return refuse('object_limit');
    for (let i = 0; i < count; i++) {
      const entry = /^(\d{10})[ ](\d{5})[ ]([nf])[ ]*(?:\r\n|\r|\n)/.exec(xref.raw.slice(xref.position)); if (!entry) return refuse('xref_entry'); xref.position += entry[0].length;
      if (entries.has(first + i) || (first + i === 0 && entry[3] === 'n')) return refuse('duplicate_or_reserved_xref'); entries.add(first + i);
      if (entry[3] === 'n') { if (offsets.has(first + i)) return refuse('duplicate_object'); offsets.set(first + i, { offset: Number(entry[1]), generation: Number(entry[2]) }); }
    }
  }
  const trailer = xref.value(); if (!isDict(trailer) || !isRef(trailer.dict.Root)) return refuse('root');
  xref.skip(); if (xrefOffset + 4 + xref.position !== tail.index) return refuse('extra_trailer');
  const sorted = [...offsets].sort((a, b) => a[1].offset - b[1].offset), objects = new Map<number, Value>();
  const streams: { dictionary: Dict; start: number; segment: string; segmentOffset: number }[] = [];
  if (!sorted.length || Number(trailer.dict.Size) !== Math.max(...offsets.keys()) + 1) return refuse('xref_size');
  const prefix = new Parser(raw.slice(0, sorted[0][1].offset)); prefix.skip(); if (prefix.position !== prefix.raw.length) return refuse('unindexed_prefix');
  for (let i = 0; i < sorted.length; i++) {
    const [id, entry] = sorted[i], end = sorted[i + 1]?.[1].offset ?? xrefOffset;
    if (entry.offset < 9 || entry.offset >= end || end > xrefOffset) return refuse('object_offset');
    const segment = raw.slice(entry.offset, end), header = /^(\d+)\s+(\d+)\s+obj\b/.exec(segment);
    if (!header || Number(header[1]) !== id || Number(header[2]) !== entry.generation) return refuse('object_identity');
    const parser = new Parser(segment); parser.position = header[0].length; const value = parser.value(); objects.set(id, value); parser.skip();
    if (segment.startsWith('stream', parser.position)) {
      if (!isDict(value)) return refuse('stream_dictionary');
      const marker = /^stream(?:\r\n|\n)/.exec(segment.slice(parser.position)); if (!marker) return refuse('stream_marker');
      streams.push({ dictionary: value, start: parser.position + marker[0].length, segment, segmentOffset: entry.offset });
    } else { if (!segment.startsWith('endobj', parser.position)) return refuse('endobj'); parser.position += 6; parser.skip(); if (parser.position !== segment.length) return refuse('unindexed_content'); }
  }
  const resolve = (value: Value | undefined): Value | undefined => { if (!isRef(value)) return value; const entry = offsets.get(value.id); if (!entry || entry.generation !== value.generation || !objects.has(value.id)) return refuse('dangling_reference'); return objects.get(value.id); };
  let imagePixels = 0;
  const walk = (value: Value, depth = 0): void => {
    if (depth > PDF_LIMITS.depth) return refuse('reference_depth');
    if (isRef(value)) { resolve(value); return; }
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    if (isDict(value)) { Object.values(value.dict).forEach(item => walk(item, depth + 1));
      if (named(value.dict.Subtype) === 'Image') { const w = resolve(value.dict.Width), h = resolve(value.dict.Height); if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return refuse('image_dimensions'); imagePixels += w * h; if (imagePixels > PDF_LIMITS.imagePixels) return refuse('image_pixel_limit'); }
    }
  };
  objects.forEach(value => walk(value)); walk(trailer);
  let inflatedBytes = 0;
  for (const stream of streams) {
    const length = resolve(stream.dictionary.dict.Length); if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || stream.start + length > stream.segment.length) return refuse('stream_length');
    const suffix = new Parser(stream.segment.slice(stream.start + length)); suffix.skip();
    if (!suffix.raw.startsWith('endstream', suffix.position)) return refuse('stream_end'); suffix.position += 9; suffix.skip();
    if (!suffix.raw.startsWith('endobj', suffix.position)) return refuse('endobj'); suffix.position += 6; suffix.skip(); if (suffix.position !== suffix.raw.length) return refuse('stream_extra_content');
    const filter = named(stream.dictionary.dict.Filter);
    if (stream.dictionary.dict.Filter && !filter) return refuse('filter_chain');
    if (filter && !['FlateDecode', 'DCTDecode', 'CCITTFaxDecode'].includes(filter)) return refuse('unsupported_filter');
    if (filter === 'DCTDecode' || filter === 'CCITTFaxDecode') { if (named(stream.dictionary.dict.Subtype) !== 'Image') return refuse('image_filter'); continue; }
    if (filter === 'FlateDecode') {
      const reader = new Blob([bytes.slice(stream.segmentOffset + stream.start, stream.segmentOffset + stream.start + length)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(); let size = 0;
      try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length; inflatedBytes += result.value.length; if (size > PDF_LIMITS.inflatedStream || inflatedBytes > PDF_LIMITS.inflatedTotal) { await reader.cancel(); return refuse('decompression_limit'); } } }
      catch (error) { if (error instanceof Error && error.message.startsWith('invalid_pdf_')) throw error; return refuse('compressed_stream'); }
    }
  }
  const root = resolve(trailer.dict.Root); if (!isDict(root) || named(root.dict.Type) !== 'Catalog') return refuse('catalog');
  const seen = new Set<number>();
  function countPages(reference: Value | undefined, parent?: Ref, depth = 0, inheritedBox?: Value): number {
    if (!isRef(reference) || depth > PDF_LIMITS.depth || seen.has(reference.id)) return refuse('page_tree'); seen.add(reference.id);
    const node = resolve(reference); if (!isDict(node)) return refuse('page_node');
    if (parent && (!isRef(node.dict.Parent) || node.dict.Parent.id !== parent.id || node.dict.Parent.generation !== parent.generation)) return refuse('page_parent');
    const box = resolve(node.dict.MediaBox ?? inheritedBox);
    if (node.dict.UserUnit !== undefined && node.dict.UserUnit !== 1) return refuse('page_scale');
    if (node.dict.Rotate !== undefined && ![0, 90, 180, 270].includes(Number(node.dict.Rotate))) return refuse('page_rotation');
    if (named(node.dict.Type) === 'Page') {
      if (!Array.isArray(box) || box.length !== 4 || box.some(v => typeof v !== 'number' || !Number.isFinite(v))) return refuse('page_dimensions');
      const [x0, y0, x1, y1] = box as number[]; if (x1 <= x0 || y1 <= y0 || x1 - x0 > 1440 || y1 - y0 > 1440) return refuse('page_dimensions');
      return 1;
    }
    if (named(node.dict.Type) !== 'Pages' || !Array.isArray(node.dict.Kids) || !node.dict.Kids.length) return refuse('page_kids');
    const count = node.dict.Kids.reduce<number>((sum, child) => sum + countPages(child, reference, depth + 1, box), 0);
    if (count !== node.dict.Count || count > PDF_LIMITS.pages) return refuse('page_count'); return count;
  }
  const pageCount = countPages(root.dict.Pages); if (pageCount < 1 || pageCount > PDF_LIMITS.pages) return refuse('page_limit');
  return { profile: 'flat-classic-xref' as const, pageCount, bytes: bytes.length, inflatedBytes, imagePixels };
}
