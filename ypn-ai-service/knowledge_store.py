from retrievers.google import search_google
from retrievers.web import fetch_page_text
from sources import TRUSTED_QUERY_PREFIX

def collect_knowledge(user_query: str) -> str:
    query = f"{TRUSTED_QUERY_PREFIX} {user_query}"
    links = search_google(query)

    combined_text = ""
    for link in links:
        combined_text += fetch_page_text(link)

    return combined_text.strip()
