class Memory:
    def __init__(self):
        self.user_name = None

    def set_name(self, name: str):
        self.user_name = name.strip()

    def get_name(self):
        return self.user_name
