// Getting started (Oct 29): the homepage only gets people set up. Using Plumb
// happens inside Claude Code and Cursor (/plumb), and in the terminal.
import { CopyCommand } from "@/components/CopyCommand";

export default function HomePage() {
  return (
    <main>
      <p className="brand">Plumb</p>
      <h1>Context from your other AI tools, already corrected</h1>
      <p className="lede">
        Ask Claude Code or Cursor for something you worked on in another tool, in your own words. Plumb brings it in,
        and tells you what has stopped being true since.
      </p>

      <section>
        <h2>Get started</h2>
        <ol className="steps">
          <li>
            <p>In a terminal, run:</p>
            <CopyCommand command="npx plumb-ai init" />
            <p className="meta">Needs Node.js 22.13 or later.</p>
          </li>
          <li>
            <p>
              Your browser opens with a code. Sign in with GitHub and approve the code if it matches your terminal.
            </p>
          </li>
          <li>
            <p>
              Say yes to bring in your past Claude Code and Cursor sessions, then restart both. New sessions save on their
              own from then on.
            </p>
          </li>
          <li>
            <p>In Claude Code or Cursor, ask for anything you did before:</p>
            <CopyCommand command="/plumb the auth refactor I did in Cursor last month" />
          </li>
        </ol>
      </section>

      <section>
        <h2>Claude chats</h2>
        <p>
          Chats from claude.ai and the Claude app live on Anthropic&apos;s servers. To bring them in: claude.ai, Settings,
          Privacy, Export data. Download the zip from the email, then run:
        </p>
        <CopyCommand command="npx plumb-ai import <the zip>" />
      </section>

      <section>
        <h2>What leaves your computer</h2>
        <ul>
          <li>Secrets (keys, tokens, passwords) are stripped before anything is sent.</li>
          <li>Plumb reads each session to write down what it decided and planned. It never stores the transcript.</li>
          <li>
            Plumb is built on Meta&apos;s Muse Spark. While Meta&apos;s service is unavailable to us, session text is
            processed by OpenAI instead.
          </li>
          <li>Your settings are merged, never replaced, and backed up first.</li>
          <li>
            Check what saved when: <code>npx plumb-ai status</code>
          </li>
          <li>
            Remove it from your computer: <code>npx plumb-ai uninstall</code>
          </li>
          <li>
            Delete your account and everything saved in it: <code>npx plumb-ai delete-account</code>
          </li>
        </ul>
      </section>
    </main>
  );
}
