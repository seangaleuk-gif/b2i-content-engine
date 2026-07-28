const parse5 = require('parse5');
const html = '<p><a href="https://x.com">Click here</a></p>';
const doc = parse5.parseFragment(html);
function walk(n, depth) {
  const indent = '  '.repeat(depth);
  const parentName = n.parentNode ? n.parentNode.nodeName : '(none)';
  const val = n.value || '';
  console.log(indent + n.nodeName + ' (parent=' + parentName + ') value="' + val + '"');
  if (n.childNodes) for (const c of n.childNodes) walk(c, depth + 1);
}
for (const c of doc.childNodes) walk(c, 0);
