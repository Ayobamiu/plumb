// Getting started (Oct 29): the homepage only gets people set up. Using Plumb
// happens inside Claude Code, Cursor and Claude Desktop (/plumb), and in the terminal.
import { CopyCommand } from "@/components/CopyCommand";

const STEPS = [
  { title: "Install", body: "Run the command above in any terminal. It needs Node.js 22.13 or later." },
  { title: "Sign in", body: "Your browser opens with a code. Sign in with GitHub and approve it if it matches your terminal." },
  { title: "Bring in your past", body: "Say yes to bring in past Claude Code and Cursor sessions. New sessions save on their own from then on." },
  { title: "Restart your tools", body: "Restart Claude Code, Cursor and Claude Desktop so they pick up Plumb." },
];

const ASKS = ["/plumb what did I build this week", "/plumb the auth refactor I did in Cursor last month", "/plumb"];

const COMMANDS = [
  { group: "Set up", items: [
    ["init", "Sign in and connect your tools. Safe to run again after an update."],
    ["backfill", "Bring in past Claude Code and Cursor sessions. Add --dry-run to only count them."],
    ["import <file>", "Bring in Claude chats from your data export."],
  ] },
  { group: "Day to day", items: [
    ["status", "See when Plumb last saved each tool."],
    ["save", "Save this folder's latest sessions right now."],
    ["stats", "See what Plumb has saved and caught."],
    ["flags <doc>", "See what stopped being true in one doc."],
  ] },
  { group: "Leave", items: [
    ["uninstall", "Remove Plumb from this computer. Your other settings stay."],
    ["delete-account", "Delete your account and everything saved in it."],
  ] },
];

export default function HomePage() {
  return (
    <main>
      <header className="hero">
        <p className="brand">Plumb</p>
        <h1>Context from your other AI tools, already corrected</h1>
        <p className="lede">
          Ask Claude Code, Cursor or Claude Desktop for something you did in another tool, in your own words. Plumb brings
          it in and tells you what has stopped being true since.
        </p>
        <CopyCommand command="npx plumb-ai init" />
      </header>

      <section>
        <h2>Get started</h2>
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>Ask from any tool</h2>
        <p>Type this in Claude Code, Cursor or Claude Desktop. Use your own words, not keywords.</p>
        <ul className="asks">
          {ASKS.map((a) => (
            <li key={a}>
              <code>{a}</code>
            </li>
          ))}
        </ul>
        <p className="meta">/plumb on its own shows what changed since you last looked.</p>
        <div className="flag">
          <p className="flag-label">Example of what Plumb tells you</p>
          <p>
            <strong>May be out of date</strong> (in &quot;Pitch deck&quot;): Slide 3 says you sign in with email. A Claude Code
            session on Tuesday switched sign-in to GitHub.
          </p>
        </div>
      </section>

      <section>
        <h2>Terminal commands</h2>
        <p>
          Run each one with <code>npx plumb-ai</code> in front, like <code>npx plumb-ai status</code>.
        </p>
        <div className="commands">
          {COMMANDS.map((c) => (
            <div key={c.group}>
              <h3>{c.group}</h3>
              <dl>
                {c.items.map(([name, what]) => (
                  <div key={name}>
                    <dt>
                      <code>{name}</code>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Claude Desktop and Claude chats</h2>
        <p>
          <strong>/plumb in Claude Desktop:</strong> init makes a file at <code>~/.plumb/plumb-skill.zip</code>. Upload it in
          Settings, Capabilities, Skills.
        </p>
        <p>
          <strong>Past Claude chats:</strong> they live on Anthropic&apos;s servers. In claude.ai, go to Settings, Privacy, Export
          data. Download the conversations file from the email while signed in, then run:
        </p>
        <CopyCommand command="npx plumb-ai import <the file>" />
      </section>

      <section>
        <h2>What leaves your computer</h2>
        <ul className="plain">
          <li>Secrets like keys, tokens and passwords are stripped before anything is sent.</li>
          <li>Plumb reads each session to write down what it decided and planned. It never stores the transcript.</li>
          <li>
            Plumb runs on Meta&apos;s Muse Spark. If Meta&apos;s standard models are down, session text goes to its contributor
            tier, which lets Meta train on what it receives.
          </li>
          <li>Your settings are merged, never replaced, and backed up first.</li>
        </ul>
      </section>
    </main>
  );
}
