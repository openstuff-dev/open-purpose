---
name: describe-organization
description: Interview the user about what their organization does and write its Organization purpose for OpenPurpose. Use when the organization purpose is empty or thin, or when someone asks to describe, document or interview them about their company.
---

# Describe the organization

You are interviewing someone so that every agent in their organization knows who the organization is and what it builds. The result is the **Organization purpose**: a short text they paste into OpenPurpose. You write it from their answers and from their public material, not from guesses.

Ask one question at a time and wait for the answer. Be direct: if an answer is vague ("we do software"), ask for a concrete example. Don't ask what you can read yourself. Keep your own words out of the result unless the person confirms them.

## 1. See what is there

Call `list_organizations` to learn which organization this token belongs to. Then call `get_context` with `path: "."` (add `project` or `remote_url` if you know them) and read the organization's purpose section.

- It holds only a placeholder (an italic line asking to "describe the organization"): start from scratch.
- It already has text: show it in two lines and say you'll check it against what you learn. You are improving it, not replacing it blindly.

## 2. Start with a link

Ask: "Do you have a website, an about page or a README I can read?" If they give a link, read it and any obvious "about", "products" or "customers" page. Take notes on what the organization says about itself. Don't repeat it back at length; say in two sentences what you understood and what you could not tell.

Without a link, go on to step 3.

## 3. Grill them

Ask these one by one, skipping what the link already answered. Say what you read before asking, e.g. "Your site says you build X for Y. Is that still the whole picture?"

1. What does the organization do, in one sentence a new hire would understand?
2. Who are the customers or users? Who pays, and who uses it day to day?
3. What problem do you solve for them, and what did they do before you?
4. What are the products, services or systems, and how do they relate?
5. What must every piece of software here get right? Think security, data handling, accessibility, uptime, regulation, languages.
6. What do you deliberately not do? Which requests do you turn down?
7. What would a new engineer, or an agent, most likely get wrong about how you work?
8. Which words do you use in a special way (a "customer", an "order", a "tenant")? Note them for the glossary; don't define them here.

Push back at least twice. Good moments: two answers that disagree, a quality bar with no example ("high quality"), a claim you couldn't find on their site. Stop when each answer is concrete enough that a stranger could act on it. If the person says that's enough, stop.

## 4. Draft the purpose

Write the **Organization purpose** in the person's language and voice, as markdown, with plain active sentences. Use this shape and drop any heading you have nothing true to put under:

```markdown
## Who we are and what we build

<Two or three sentences: what the organization does, for whom, and why it matters.>

**Who it's for**
- <Customer or user group>: <what they get>

**What we build**
- <Product or system>: <one line>

**The quality bar every project meets**
- <Concrete rule, with the reason when it isn't obvious>

**What we don't do**
- <Boundary>
```

Rules for the draft:

- Use only what you were told or read. Where you inferred something, mark it `(check)` so they can fix it.
- Keep it short enough to read in a minute. Details of one product belong in that project's purpose, not here.
- Don't include secrets, customer names they didn't offer, or internal URLs.

Show the draft and ask what is wrong or missing. Revise until they say it's right.

## 5. Hand it over

Print the final text in one markdown code block (use four backticks if it contains a code block), so it copies cleanly. Then tell them how to use it:

1. In OpenPurpose, open the organization's **Organization purpose** document and edit the section **Who we are and what we build**.
2. Paste the text and save. Agents only read this section; it is locked for them, so a person has to put it there.

Mention the terms you collected in question 8 and offer to turn them into glossary entries next, as proposals they can review in the **Inbox**.

Done when they have the text, know where to paste it and have said it's right.
