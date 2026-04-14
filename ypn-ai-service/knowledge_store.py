_store = {}


def add_document(doc_id: str, text: str):
    _store[doc_id] = text


def get_all():
    return _store


def search(query: str):
    results = []
    for k, v in _store.items():
        if query.lower() in v.lower():
            results.append({"id": k, "text": v})
    return results


def reset_store():
    _store.clear()