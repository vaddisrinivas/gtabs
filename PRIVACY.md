# Privacy Policy for gTabs - AI Tab Organizer

**Last updated:** April 3, 2026

## Summary

gTabs does not collect, transmit, or store any personal data on external servers. All extension data stays in your browser's local storage. When you choose to use a cloud LLM provider, tab titles and URLs are sent to that provider's API — and only when you explicitly trigger an organize action.

## Data Collection

gTabs does **not** collect:
- Personal information (name, email, account details)
- Browsing history beyond the current window's open tabs
- Analytics, telemetry, or usage tracking data
- Cookies or cross-site tracking identifiers

## Data Stored Locally

The following data is stored in your browser's local `chrome.storage` area and never leaves your device:

- **Extension settings** — your chosen LLM provider, model, behavior preferences, and UI options
- **API keys** — stored locally in `chrome.storage.local`, never transmitted anywhere except to the provider you selected
- **Domain rules** — custom rules you create for grouping specific domains
- **Learning data** — domain affinity scores, correction history, rejection memory, and co-occurrence patterns used by the Smart Learning system
- **Pinned groups** — group names you've pinned to survive re-organization
- **Usage statistics** — organize count and tabs grouped count, stored locally for your reference

You can export or delete all stored data at any time from the extension's settings page.

## Data Sent to Third Parties

### When you use a cloud LLM provider

If you configure gTabs to use a cloud-based LLM provider (OpenAI, Anthropic, OpenRouter, Groq, or xAI), the following data is sent to that provider's API **only when you trigger an organize action** (manually or via scheduled re-org):

- **Tab titles** (truncated to your configured length)
- **Tab URLs**
- **Your API key** (for authentication with the provider)
- **Grouping hints** derived from your learning data (domain affinities, rejection history)

This data is sent directly from your browser to the provider's API endpoint. gTabs has no intermediary server.

**Important:** Each cloud LLM provider has its own privacy policy and data retention practices. By choosing a cloud provider, you are subject to that provider's terms. gTabs has no control over how providers handle the data they receive. Review your chosen provider's privacy policy:

- OpenAI: https://openai.com/policies/privacy-policy
- Anthropic: https://www.anthropic.com/privacy
- OpenRouter: https://openrouter.ai/privacy
- Groq: https://groq.com/privacy-policy
- xAI: https://x.ai/legal/privacy-policy

### When you use a local LLM provider

If you use **Ollama** or **Chrome Built-in AI**, all processing happens on your device. No tab data is sent to any external server.

## Permissions

gTabs requests the following Chrome permissions:

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab titles and URLs to generate grouping suggestions |
| `tabGroups` | Create, modify, and remove tab groups |
| `storage` | Save your settings, learning data, and API keys locally |
| `alarms` | Run scheduled re-organization and auto-organize checks |
| `contextMenus` | Add right-click menu options for quick access |
| `windows` | Support consolidate-windows feature |
| Host permissions | Send requests to the LLM API endpoint you selected |

## Children's Privacy

gTabs is not directed at children under 13 and does not knowingly collect data from children.

## Changes to This Policy

If this policy is updated, the changes will be published in this file in the extension's repository with an updated date. Continued use of the extension after changes constitutes acceptance.

## Contact

If you have questions about this privacy policy, open an issue at: https://github.com/vaddisrinivas/gtabs/issues
