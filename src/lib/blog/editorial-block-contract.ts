/** Exact structured-output contract shared by every English prose producer. */
export const EDITORIAL_BLOCK_JSON_CONTRACT = `Return one JSON object containing structured editorial blocks in a non-empty "blocks" array. Exact shapes:
- paragraph: {"type":"paragraph","text":"Complete text."}
- subheading: {"type":"subheading","text":"H3 text"}
- quote: {"type":"quote","text":"Complete quotation."}
- list: {"type":"list","ordered":false,"items":["First item","Second item"]}
- table: {"type":"table","headers":["Column A","Column B"],"rows":[["A1","B1"]]}
Use one list block containing all related items; never put a list item in "text" or emit an empty list. A paragraph may end with a colon only when the immediately following non-empty list or table completes it.`;
