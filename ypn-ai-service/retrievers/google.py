import os
from googleapiclient.discovery import build
from dotenv import load_dotenv

load_dotenv()

CSE_ID = os.getenv("GOOGLE_CSE_ID")

def search_google(query: str, limit: int = 5):
    service = build("customsearch", "v1")
    response = service.cse().list(
        q=query,
        cx=CSE_ID,
        num=limit
    ).execute()

    results = []
    for item in response.get("items", []):
        results.append(item["link"])

    return results
