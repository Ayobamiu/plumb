import { getCursor, getGmailRefreshToken } from "./lib/supabase.js";

const refresh = await getGmailRefreshToken();
console.log(refresh ? "refresh_token: present" : "refresh_token: missing");
const cursor = await getCursor("gmail");
console.log(cursor ? "cursor: present" : "cursor: none (first run)");
