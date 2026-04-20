# VCFO – Developer Notes

## Overview

VCFO is a virtual CFO web application that provides financial planning, forecasting, and analysis tools.

---

## Tech Stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend/Functions:** Netlify Functions (serverless)
- **Hosting:** Netlify
- **Config:** `netlify.toml`

---

## Project Structure

```
vcfo/
├── functions/          # Netlify serverless functions
├── index.html          # Main app entry point
├── index_backup.html   # Backup of index
├── competitor-bench.html  # Competitor benchmarking page
├── netlify.toml        # Netlify configuration
└── dev.md              # This file
```

---

## Local Development

1. Clone the repository:
   ```bash
      git clone https://github.com/youngmbg21-cmyk/vcfo.git
         cd vcfo
            ```

            2. Install the Netlify CLI (if not already installed):
               ```bash
                  npm install -g netlify-cli
                     ```

                     3. Run the dev server locally:
                        ```bash
                           netlify dev
                              ```

                              4. Open your browser at `http://localhost:8888`

                              ---

                              ## Deployment

                              Deployments are handled automatically via Netlify on push to the `main` branch.

                              - **Production branch:** `main`
                              - **Deploy previews:** enabled on pull requests

                              ---

                              ## Environment Variables

                              Set any required environment variables in the Netlify dashboard under **Site Settings > Environment Variables**.

                              ---

                              ## Contributing

                              1. Create a feature branch off `main`
                              2. Make your changes
                              3. Open a pull request for review before merging

                              ---

                              ## Notes

                              - Keep `index_backup.html` in sync with major changes to `index.html`
                              - Serverless functions live in `/functions` — each file is its own endpoint 
