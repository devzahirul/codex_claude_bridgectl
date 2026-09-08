import { useState } from 'react';

/** Fenced code with a copy button. `lang` is a label only, not a highlighter. */
export default function CodeBlock({ code, lang = 'bash' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="code">
      <div className="code-bar">
        <span className="code-lang">{lang}</span>
        <button type="button" onClick={copy} aria-label="Copy code">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}
