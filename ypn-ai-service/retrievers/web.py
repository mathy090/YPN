import requests
from bs4 import BeautifulSoup

def fetch_page_text(url: str) -> str:
    try:
        headers = {
            "User-Agent": "YPN-AI Public Information Bot"
        }
        r = requests.get(url, headers=headers, timeout=10)
        r.raise_for_status()

        soup = BeautifulSoup(r.text, "html.parser")

        for tag in soup(["script", "style", "header", "footer", "nav"]):
            tag.decompose()

        paragraphs = [p.get_text() for p in soup.find_all("p")]
        text = " ".join(paragraphs)

        return text[:4000]

    except Exception:
        return ""
