from knowledge_store import add_document, reset_store

def seed_knowledge():
    reset_store()

    docs = [
        {
            "id": "cbt_basics",
            "text": "Cognitive Behavioral Therapy (CBT) helps people identify and reframe negative thinking patterns."
        },
        {
            "id": "breathing_techniques",
            "text": "Deep breathing techniques can reduce stress by activating the parasympathetic nervous system."
        },
        {
            "id": "grounding",
            "text": "Grounding exercises help reduce anxiety by focusing attention on the present moment using senses."
        },
        {
            "id": "sleep_hygiene",
            "text": "Good sleep hygiene includes consistent sleep schedules and reducing screen time before bed."
        }
    ]

    for d in docs:
        add_document(d["id"], d["text"])

if __name__ == "__main__":
    seed_knowledge()