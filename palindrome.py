def is_palindrome(s: str) -> bool:
    """Checks if a string is a palindrome."""
    clean_s = ''.join(char.lower() for char in s if char.isalnum())
    return clean_s == clean_s[::-1]
