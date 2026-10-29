import { Home } from "@/components/Home";
import { hasServerDb } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!hasServerDb()) {
    return (
      <main>
        <p className="brand">Plumb</p>
        <h1>What stopped being true</h1>
        <p className="lede">
          One question: what stopped being true since you last looked, and why?
        </p>
        <div className="banner error" role="alert">
          Missing SUPABASE_SERVICE_ROLE_KEY in the repo root .env. The homepage
          reads through the service role until RLS read policies land. Add the
          key from the Supabase dashboard (Settings → API), then restart{" "}
          <code>pnpm --filter @plumb/web dev</code>.
        </div>
      </main>
    );
  }

  return (
    <main>
      <p className="brand">Plumb</p>
      <h1>What stopped being true</h1>
      <p className="lede">
        Claims that went OUT or REVIEW, grouped with what broke them. Projects
        below show what is still IN.
      </p>
      <Home />
    </main>
  );
}
