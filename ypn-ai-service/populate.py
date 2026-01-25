from knowledge_store import collect_knowledge

def preload():
    topics = [
        "youth counselling Zimbabwe",
        "youth employment programs Zimbabwe",
        "youth empowerment initiatives Zimbabwe"
    ]

    data = []
    for topic in topics:
        data.append(collect_knowledge(topic))

    return data
