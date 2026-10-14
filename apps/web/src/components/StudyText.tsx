import { Fragment, type ReactNode } from 'react';

/** Model/source text stays escaped React text. No HTML or executable markup. */
function inline(text: string): ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/u)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}
export function StudyText({ text }: { text: string }) {
  const blocks = text
    .replace(/\r\n/gu, '\n')
    .split(/(```[\s\S]*?(?:```|$))/u)
    .filter(Boolean);
  return (
    <div className="study-rich-text">
      {blocks.flatMap((block, index) => {
        if (block.startsWith('```')) {
          const code = block.replace(/^```[^\n]*\n?/u, '').replace(/```$/u, '');
          return (
            <pre key={`code-${index}`}>
              <code>{code}</code>
            </pre>
          );
        }
        return block
          .replace(/^(#{1,6}[^\n]+)\n(?!\n)/gmu, '$1\n\n')
          .replace(
            /^[ \t]*\|[^\n]*\|[ \t]*(?:\n|$)(?:[ \t]*\|[^\n]*\|[ \t]*(?:\n|$))*/gmu,
            '\n\n$&\n\n',
          )
          .trim()
          .split(/\n\s*\n/u)
          .filter(Boolean)
          .map((paragraph, i) => {
            const key = `${index}-${i}`;
            const lines = paragraph.split('\n');
            if (lines.length > 1 && lines.every((line) => /^\s*\|.*\|\s*$/u.test(line))) {
              const rows = lines.filter((line) => !/^\s*\|[\s:|-]+\|\s*$/u.test(line));
              return (
                <div className="study-table-scroll" key={key}>
                  <table>
                    <tbody>
                      {rows.map((line, r) => (
                        <tr key={r}>
                          {line
                            .trim()
                            .slice(1, -1)
                            .split('|')
                            .map((cell, c) =>
                              r === 0 ? (
                                <th key={c}>{inline(cell.trim())}</th>
                              ) : (
                                <td key={c}>{inline(cell.trim())}</td>
                              ),
                            )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }
            if (lines.every((line) => /^\s*[-*]\s+/u.test(line)))
              return (
                <ul key={key}>
                  {lines.map((line, l) => (
                    <li key={l}>{inline(line.replace(/^\s*[-*]\s+/u, ''))}</li>
                  ))}
                </ul>
              );
            if (lines.every((line) => /^\s*\d+[.)]\s+/u.test(line)))
              return (
                <ol key={key}>
                  {lines.map((line, l) => (
                    <li key={l}>{inline(line.replace(/^\s*\d+[.)]\s+/u, ''))}</li>
                  ))}
                </ol>
              );
            if (/^#{1,6}\s/u.test(paragraph))
              return <h3 key={key}>{inline(paragraph.replace(/^#{1,6}\s+/u, ''))}</h3>;
            if (paragraph.startsWith('> '))
              return <blockquote key={key}>{inline(paragraph.replace(/^>\s?/gmu, ''))}</blockquote>;
            return <p key={key}>{inline(paragraph)}</p>;
          });
      })}
    </div>
  );
}
