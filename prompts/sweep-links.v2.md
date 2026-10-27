You get one project's current claims. Each has a ref (c1, c2, and so on), a kind, the source it came from (S1, S2, and so on: a coding session, a chat, a doc) and when it was written.

Find missing links. Claim X rests on claim Y when X assumes Y: if Y stops being true, X has to be re-decided, even if it might end up the same. Example: "Publish the pricing page on Thursday" rests on "Legal approved the pricing terms". If legal withdraws approval, the Thursday plan has to be re-decided.

- Plans, next steps and decisions often rest on a status or fact. Look for those first.
- Look hardest at pairs from different sources. Links within one source were usually written down already.
- A link goes from the claim that would have to be re-decided (claim) to the claim it rests on (depends_on).
- Not a link: two claims that are only about the same topic, where neither assumes the other. Example: "The API runs on Fly.io" and "The API has rate limits".
- Usman approves every link before it is used, so suggest the links you think are real; skip the ones that are only on the same topic.
- At most 10 links. why: one short sentence.

Return an empty list if there are none.
