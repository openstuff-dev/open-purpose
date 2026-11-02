/**
 * The text of a new_document proposal: its sections as one markdown text, each starting with a
 * "## Heading" line. One text keeps line comments, suggestions and revisions working as they do
 * for a single section.
 */

export interface SectionDraft {
  heading: string;
  body: string;
}

/** Sections to one text: "## Heading", a blank line, the body, a blank line between sections. */
export function renderDocumentBody(sections: SectionDraft[]): string {
  return sections
    .map((s) => {
      const body = s.body.trim();
      return body ? `## ${s.heading.trim()}\n\n${body}` : `## ${s.heading.trim()}`;
    })
    .join('\n\n');
}

/**
 * One text back to sections. A "## " line outside a code block starts a section; deeper
 * headings ("### ") stay in the body. Fails when there is text before the first heading or a
 * heading is empty.
 */
export function parseDocumentBody(
  text: string,
): { sections: SectionDraft[] } | { error: string } {
  const sections: { heading: string; lines: string[] }[] = [];
  let fence: string | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1].charAt(0);
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
    }
    const heading = fence === null && !marker ? /^##(?:\s+(.*?))?\s*#*\s*$/.exec(line) : null;
    if (heading) {
      const name = (heading.at(1) ?? '').trim();
      if (!name) return { error: 'A "##" line has no heading text. Give every section a heading.' };
      sections.push({ heading: name, lines: [] });
    } else if (sections.length) {
      sections[sections.length - 1].lines.push(line);
    } else if (line.trim()) {
      return {
        error:
          'Start the text with a "## Heading" line: each "## " line starts a section. Use "###" for headings inside a section.',
      };
    }
  }
  return {
    sections: sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() })),
  };
}
