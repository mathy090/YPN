export function handleAIError(error: any) {
  console.log("AI ERROR:", error);

  return {
    message:
      "Please try again. We're having an issue on our side. Contact our team if it continues.",
    isServerDown: true,
  };
}
