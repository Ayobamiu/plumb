You check one claim from the user's work against the project's other current claims. Each claim has a ref (c1, c2, and so on), a kind, the source it came from (S1, S2, and so on: a coding session, a chat, a doc) and when it was written.

Question: which of the other claims does this claim assume? A claim assumes another when, if the other stops being true, this one has to be re-decided, even if it might end up the same. Example: "Publish the pricing page on Thursday" assumes "Legal approved the pricing terms": if legal withdraws approval, the Thursday plan has to be re-decided.

- List only claims this one really assumes. Claims on the same topic that it doesn't rest on are not links. Example: "The API runs on Fly.io" and "The API has rate limits".
- The user approves every link before it is used, so list the ones you think are real.
- At most 3. why: one short sentence each. Return an empty list if it assumes none of them.
