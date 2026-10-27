You get one project's current claims. Each has a ref (c1, c2, and so on), a kind, the source it came from (S1, S2, and so on: a coding session, a chat, a doc) and when it was written.

Find missing "only true while" links: claim X only makes sense while claim Y holds, so if Y stops being true, X has to be rethought. Example: "Publish the pricing page on Thursday" only makes sense while "Legal approved the pricing terms" holds.

- Look hardest at pairs from different sources. Links within one source were usually written down already.
- A link goes from the claim that would have to change (claim) to the claim it rests on (depends_on).
- Not a link: two claims about the same topic, or two claims where one being false leaves the other still sensible. Example: "The API runs on Fly.io" and "The API has rate limits" are on the same topic, but neither rests on the other.
- When in doubt, leave it out. Usman approves every link, and a wrong link would later knock down a claim that is still true.
- At most 10 links. why: one short sentence.

Return an empty list if there are none.
