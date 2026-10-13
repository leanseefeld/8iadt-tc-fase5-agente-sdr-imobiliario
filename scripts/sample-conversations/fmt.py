"""Print sample conversations as Markdown quotes, read from the app's history API, unedited.

    python3 fmt.py <session-id> [...]

The output is what docs/exemplos/conversas.md quotes.
"""
import json, os, sys, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

BASE = os.environ.get("APP_URL", "http://localhost:3100")
BRT = timezone(timedelta(hours=-3))

def history(session):
    q = urllib.parse.urlencode({"agencySlug": "demo", "sessionId": session})
    with urllib.request.urlopen(f"{BASE}/api/chat?{q}", timeout=120) as r:
        return json.loads(r.read())

def render(session):
    h = history(session)
    out = []
    for m in h["messages"]:
        who = {"lead": "**Lead**", "agent": "**Sofia**", "broker": "**Corretor**"}[m["role"]]
        at = datetime.fromisoformat(m["createdAt"].replace("Z", "+00:00")).astimezone(BRT).strftime("%H:%M")
        text = m["content"].replace("\n", "<br>")
        extra = ""
        if m.get("propertyIds"):
            extra += f" *(+ {len(m['propertyIds'])} cartões de imóveis)*"
        if m.get("booking"):
            b = m["booking"]
            extra += f" *(cartão de confirmação: {'visita' if b['type'] == 'viewing' else 'ligação'}{' ao ' + b['propertyCode'] if b.get('propertyCode') else ''})*"
        out.append(f"> `{at}` {who}: {text}{extra}")
    return "\n>\n".join(out)

if __name__ == "__main__":
    for session in sys.argv[1:]:
        print(f"<!-- {session} -->")
        print(render(session))
        print()
