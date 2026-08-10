import sys, glob, re

def find_tags(content, tag_name):
    """Find all opening tags <tag_name ...> respecting nested {} and quotes, return (start, end, tag_text)."""
    results = []
    i = 0
    n = len(content)
    pattern = f"<{tag_name}"
    while True:
        idx = content.find(pattern, i)
        if idx == -1:
            break
        # must be followed by whitespace or > or / to be a real tag, not e.g. <buttonX
        after = content[idx+len(pattern):idx+len(pattern)+1]
        if after not in (" ", ">", "\n", "\t", "/"):
            i = idx + len(pattern)
            continue
        j = idx + len(pattern)
        depth = 0
        in_str = None
        while j < n:
            c = content[j]
            if in_str:
                if c == in_str and content[j-1] != "\\":
                    in_str = None
            elif c in ('"', "'", "`"):
                in_str = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            elif c == ">" and depth == 0:
                break
            j += 1
        tag_text = content[idx:j+1]
        results.append((idx, j+1, tag_text))
        i = j + 1
    return results

def audit_file(path):
    content = open(path, encoding="utf-8", errors="ignore").read()
    issues = []
    for start, end, tag in find_tags(content, "button"):
        has_onclick = "onClick" in tag
        has_type_submit = 'type="submit"' in tag or "type='submit'" in tag
        has_disabled_only = "disabled" in tag and not has_onclick
        if not has_onclick and not has_type_submit:
            # get a snippet of context (next 80 chars after tag, likely the button label)
            snippet = content[end:end+80].replace("\n", " ")
            line_no = content[:start].count("\n") + 1
            issues.append((line_no, tag[:120], snippet))
    return issues

for path in sys.argv[1:]:
    issues = audit_file(path)
    if issues:
        print(f"=== {path} ({len(issues)} button(s) with no onClick and not type=submit) ===")
        for line_no, tag, snippet in issues:
            print(f"  L{line_no}: {tag} ... label-ish: {snippet[:60]}")
