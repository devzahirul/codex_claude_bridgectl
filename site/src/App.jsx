import CodeBlock from './components/CodeBlock.jsx';
import Section from './components/Section.jsx';
import { REPO, NAV, FEATURES, PROFILES, COMMANDS, CONFIG, COST, FAQ } from './data.js';

const FLOW = `codex --POST /v1/responses--> bridge --claude -p--> Claude
                                 |
codex <--SSE function_call-------+
   |
   +- codex executes the tool, returns function_call_output, loop repeats`;

const QUICKSTART = `git clone ${REPO}.git
cd codex_claude_bridgectl
./bridgectl setup     # writes codex profiles, main config untouched
./bridgectl start     # start the local server
./bridgectl doctor    # confirm everything is healthy

codex --profile claude "add a --json flag and run the tests"`;

const PATH_SETUP = `mkdir -p ~/.local/bin
ln -sf "$PWD/bridgectl" ~/.local/bin/bridgectl

# zsh (macOS default)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

which bridgectl   # -> /Users/you/.local/bin/bridgectl`;

const PREREQS = `node --version      # v18 or newer
codex --version
claude --version
claude -p "say ok"  # must answer without prompting for login`;

export default function App() {
  return (
    <>
      <header className="nav">
        <div className="container nav-inner">
          <a className="brand" href="#top">
            codex<span>&#8644;</span>claude
          </a>
          <nav>
            {NAV.map((item) => (
              <a key={item.href} href={item.href}>{item.label}</a>
            ))}
          </nav>
          <a className="btn btn-ghost" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="container">
            <p className="eyebrow">local bridge &middot; MIT licensed &middot; zero dependencies</p>
            <h1>Let the Codex CLI drive <span className="grad">Claude</span>.</h1>
            <p className="lead">
              Codex believes it is talking to an OpenAI model over the Responses API.
              It is actually talking to the <code>claude</code> CLI on your machine.
              <strong> Claude decides. Codex executes</strong> - inside its own sandbox
              and approval policy.
            </p>
            <div className="cta">
              <a className="btn btn-primary" href="#install">Get started</a>
              <a className="btn btn-ghost" href={REPO} target="_blank" rel="noreferrer">View source</a>
            </div>
            <pre className="flow">{FLOW}</pre>
          </div>
        </section>

        <Section id="how" eyebrow="how it works" title="A real tool loop, not a wrapper"
          lead="Claude runs with its own tools switched off, so it cannot touch your filesystem. The only route to action is a function_call handed back to Codex.">
          <div className="grid">
            {FEATURES.map((f) => (
              <article key={f.title} className="card">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section id="install" eyebrow="install" title="Running in under a minute"
          lead="Nothing to build, nothing to install globally. The cloned directory is the installation.">
          <h3 className="sub">1. Check prerequisites</h3>
          <p className="note">macOS or Linux, Node 18+, the codex CLI, and the claude CLI already logged in.</p>
          <CodeBlock code={PREREQS} />

          <h3 className="sub">2. Clone and set up</h3>
          <CodeBlock code={QUICKSTART} />

          <h3 className="sub">3. Put bridgectl on your PATH (optional)</h3>
          <p className="note">
            Symlink rather than copy - <code>bridgectl</code> resolves its own location
            through symlinks to find <code>bridge.mjs</code>.
          </p>
          <CodeBlock code={PATH_SETUP} />

          <div className="callout">
            <strong>Profile mode is the default and the safe one.</strong> It only adds
            files under <code>~/.codex</code>. Reach for <code>setup --global</code> only
            when you want every bare <code>codex</code> call to go through Claude - it
            backs your config up first and <code>uninstall</code> restores it.
          </div>
        </Section>

        <Section id="profiles" eyebrow="profiles" title="One server, every model and effort"
          lead="Codex sends its model and reasoning effort on every request, so switching profile needs no restart.">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>profile</th><th>model</th><th>effort</th><th>via</th></tr>
              </thead>
              <tbody>
                {PROFILES.map((row) => (
                  <tr key={row[0]}>
                    <td><code>{row[0]}</code></td>
                    <td>{row[1]}</td>
                    <td>{row[2]}</td>
                    <td>{row[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeBlock code={'codex --profile claude       "routine task"\ncodex --profile claude-xhigh "hard refactor"\ncodex --profile sol-high     "same task, no bridge"'} />
        </Section>

        <Section id="commands" eyebrow="bridgectl" title="Command reference">
          <div className="table-wrap">
            <table>
              <thead><tr><th>command</th><th>what it does</th></tr></thead>
              <tbody>
                {COMMANDS.map((row) => (
                  <tr key={row[0]}>
                    <td><code>{row[0]}</code></td>
                    <td>{row[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="config" eyebrow="configuration" title="Options"
          lead="Settings live in ~/.codex-claude-bridge/env and are sourced on start. Explicit BRIDGE_* values in your shell win over that file.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>variable</th><th>default</th><th>meaning</th></tr></thead>
              <tbody>
                {CONFIG.map((row) => (
                  <tr key={row[0]}>
                    <td><code>{row[0]}</code></td>
                    <td><code>{row[1]}</code></td>
                    <td>{row[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="cost" eyebrow="cost" title="Turns x cached prefix"
          lead="Every Codex turn is a full Claude turn, so cost scales with turns and cache hits - not with how much text you send. Same 7-turn bug-fix task, run end to end.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>config</th><th>turns</th><th>cost</th><th>vs baseline</th></tr></thead>
              <tbody>
                {COST.map((row) => (
                  <tr key={row[0]}>
                    <td>{row[0]}</td>
                    <td>{row[1]}</td>
                    <td>{row[2]}</td>
                    <td className={row[3].startsWith('-') ? 'good' : row[3] ? 'bad' : ''}>{row[3] || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="callout">
            <strong>Rewriting the context makes it worse.</strong> Prompt caching matches
            on the prefix from byte zero, so summarising or reordering earlier turns
            invalidates every token after the edit - trading a 10x discount for a ~30%
            token reduction. The stateless row measures exactly that: +84%.
          </div>
          <CodeBlock code={'BRIDGE_COST_LOG=~/bridge-cost.jsonl bridgectl restart\nnode cost-report.mjs ~/bridge-cost.jsonl'} />
        </Section>

        <Section id="faq" eyebrow="faq" title="Questions">
          <div className="faq">
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </Section>
      </main>

      <footer className="footer">
        <div className="container footer-inner">
          <p>
            MIT licensed. Built for the <code>codex</code> and <code>claude</code> CLIs -
            no affiliation with, or endorsement by, OpenAI or Anthropic.
          </p>
          <a href={REPO} target="_blank" rel="noreferrer">github.com/devzahirul/codex_claude_bridgectl</a>
        </div>
      </footer>
    </>
  );
}
