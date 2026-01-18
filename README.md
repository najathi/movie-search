# isaimini3-mcp

MCP server that searches Isaamini3 and returns movie links for a query.

## Setup

```bash
npm install
npm run build
```

## Run

```bash
npm run start
```

## Tool

- `search_movie_links`
  - `baseUrl` (string URL, required)
  - `query` (string, required)
  - `maxResults` (number, optional, default 10)

### Example tool call

```json
{
  "baseUrl": "https://moviesda15.com",
  "query": "Alappuzha Gymkhana",
  "maxResults": 5
}
```

The server returns a JSON payload with `results` containing `{ title, url }`.

## Notes

- If the site changes its search URL, update the candidate list in `src/index.ts`.
- The Tamil domain `இசைமினி3.com` resolves to `https://isaimini3.com`.
