# Spec 015 — What Sofia can't resolve

**Format:** one page, like 009's. The developer agreed on 30/09/2026 that this spec doesn't follow the Spec Kit to
the letter. Every decision here was taken by the developer on the page "Fronteira da Sofia" (v1 and v2, 30/09).
The examples are the acceptance tests. Anything the page doesn't say isn't a requirement.

## What it is

Today the extraction is a closed list of fields, and a message none of them covers falls into one of four holes:

- a promise nobody backs ("vou te mostrar opções" with no search);
- a close by mistake ("meu marido vai junto" → "Combinado! Fica marcado…");
- a flat refusal;
- a misunderstanding that counts towards a handoff.

015 gives the agent a way to notice what it can't resolve and **offer** — never push — to have someone from the
team check it.

## What it covers

- **What the message does.** The extraction says what the lead's message does: *thanks* (or says goodbye),
  *agrees*, *answers*, *requests*, *asks*, *informs*, or *other*. It also returns the **remainder**: the part of
  the message no other field captured.
- **The safety net.** A message that is **only** thanks or agreement is recognised by code, whatever the model
  said: obrigado, valeu, ok, beleza, show, perfeito, combinado, 👍 and the like. It works the way code already
  reads "amanhã" or "quinta". "Obrigado, e meu marido vai junto" is not only thanks, so the model decides that one.
- **The boundary.** A request, question or piece of information in the remainder that nothing in the turn
  handled gets this reply:
  1. acknowledge it;
  2. say it can't be guaranteed or resolved from the chat;
  3. **offer** to have someone from the team check it.

  The model writes the sentence. The code decides when, and remembers the offer.

  What the lead says next:
  - **yes** → the normal handoff;
  - **no** → a close;
  - **anything else** → the normal turn, and the offer is dropped.
- **What Sofia can and can't do**, a fixed part of the reply prompt:
  - **can:** search the catalog; book, reschedule and cancel a visit or a phone call; explain the search criteria;
  - **can't guarantee:** anything about a visit beyond its day and time (who comes along, pets, keys, parking),
    discount and negotiation, financing and documents, condominium rules;
  - **never** says it did or will do something outside the list.

  It sits in the constant part of the prompt, so the prompt cache keeps it.
- **Discount and negotiation** move from "refuse politely" to the boundary offer.
- **The close.** The code writes the summary of what's booked ("Fica marcado: …"). The model writes the courtesy
  around it, under a closing instruction. A second close in a row stays short: courtesy only, no summary. A "no"
  to the boundary offer closes the same way.

## What it doesn't cover

- Requests the agency doesn't do stay **refusals**: a ride, a refund, choosing the broker by a personal trait. The
  boundary is for what someone on the team **can** resolve.
- "Tanto faz" answers (spec 011).
- Answering from documents (011's FAQ with RAG). When 011 lands, it looks there first and falls back to this
  boundary.
- The handoff itself (spec 004): a "yes" uses it unchanged.

## Already decided (specs 004, 006, 009)

- Code decides and the model phrases.
- Code-written sentences (options, confirmations, "quer mesmo cancelar?") are said verbatim.
- Pending state lives on the agent message's metadata.
- A handoff is written, never phrased.
- No broker name reaches the lead.
- One question per message.

## Examples

1. **Husband, after booking.** Booked: a visit to MOE-0001 on Monday at 10h.
   - Lead: *"meu marido vai junto"* → Sofia acknowledges it, says she can't confirm that from here, and offers to
     have someone from the team check.
   - Lead: *"não precisa"* → a short close written by the model, with no new offer.
2. **Dog.** Lead: *"o condomínio aceita cachorro?"* → Sofia says she doesn't have that information and offers to
   have someone from the team check.
   - Lead: *"quero"* → the normal handoff ("Claro, já estou chamando um corretor…").
3. **Discount.** Lead: *"consegue um desconto?"* → Sofia says she can't negotiate from here and offers someone from
   the team. It's no longer a refusal.
4. **Ride.** Lead: *"vocês me dão carona até lá?"* → a refusal, as today.
5. **Thanks.**
   - After booking, *"valeu!"* → the code summary plus the model's courtesy. It's never a boundary offer, even if
     the model read the message as *informs*.
   - A second *"obrigado"* → courtesy only.
6. **Thanks with times on the table.** *"obrigado!"* while options are open doesn't close. The options stay.
7. **Mixed.** *"obrigado, e meu marido vai junto"* after booking → the boundary offer (example 1), not the close.

## Decided on the morning of 30/09

- **Answering from the state.** The phrasing's state lists **what is booked**, like the criteria. It costs a line
  per meeting, and only when there is one, which is less than a tool call. A question about a booked meeting
  (*"a visita de segunda continua de pé?"*) is answered from it. With nothing booked, the answer is *"Não tenho
  nenhuma visita ou conversa marcada… Quer marcar uma?"*.
- **The close.** The model gets the summary and says it and the goodbye in its own words. It no longer gets a
  code prefix.
- **Who attends.** *"Daqui eu só consigo ver o dia, o horário, o tipo e o imóvel do que está marcado; quem vai te
  atender, só os corretores conseguem confirmar. Quer que eu chame um corretor pra tirar essa ou outra dúvida?"*
  - A yes is the handoff.
  - A broker who spoke stays the authority; nobody is named.
- **From the developer's phone test that morning.**
  - A change of purpose must be said: *"isso"* no longer turns a renter into a buyer.
  - Sofia never offers to search: the search runs by itself when the criteria are complete.

## Open questions

None open. Answered on 30/09: the direction (act + remainder + boundary + capability list); a short spec before
011; the close (summary by code, courtesy by the model); discount becomes an offer; the thanks safety net by code.
