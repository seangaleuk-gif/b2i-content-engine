/** Exact structured-output contract shared by every English prose producer. */
export const EDITORIAL_BLOCK_JSON_CONTRACT = `Return one JSON object containing structured editorial blocks in a non-empty "blocks" array. Exact shapes:
- paragraph: {"type":"paragraph","sentences":[{"text":"Complete sentence one.","kind":"free_prose"},{"text":"Complete sentence two.","kind":"source_fact","evidenceIds":["SOURCE-1-CLAIM-2"]}]}
- subheading: {"type":"subheading","text":"H3 text"}
- quote: {"type":"quote","text":"Complete quotation."}
- list: {"type":"list","ordered":false,"items":[{"text":"First item","kind":"free_prose"}]}
- table: {"type":"table","headers":["Column A","Column B"],"rows":[["A1","B1"]]}
Use one list block containing all related items; never put a list item in "text" or emit an empty list. A paragraph may end with a colon only when the immediately following non-empty list or table completes it.

STRUCTURAL SENTENCE PROVENANCE (factual-capable components only): paragraph and list sentences are returned as sentence objects; each generated sentence exists EXACTLY ONCE inside its block and carries its own kind:
- "kind":"source_fact" — the sentence asserts a concrete external-world fact derived from approved research; add "evidenceIds":["SOURCE-1-CLAIM-2"] using ONLY the evidence IDs supplied to you.
- "kind":"free_prose" — the sentence is ONLY advice, guidance, opinion, rhetorical prose or a clearly hypothetical/illustrative example; it must NEVER assert a concrete external-world fact (no statistics, numbers, dates, currencies, platform capabilities, payment mechanics, company behaviour or market claims) and must NOT carry evidenceIds.
Every paragraph sentence and every list item must carry a kind — there is no separate accounting list. This metadata is internal-only and is NEVER rendered into the article. Components that receive no approved evidence (introduction, conclusion, FAQ) must return plain text blocks and no provenance.`;
