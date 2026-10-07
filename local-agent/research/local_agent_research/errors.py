class ToolError(ValueError):
    """An expected failure safe to return to the model."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

    def result(self) -> dict:
        return {"ok": False, "error": self.code, "message": str(self)}
