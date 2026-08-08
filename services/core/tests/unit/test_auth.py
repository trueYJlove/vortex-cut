from aivs_core.auth import AuthStore


def test_auth_store_only_retains_hashes() -> None:
    auth = AuthStore("admin-secret")
    assert auth.admin_token == ""
    assert auth.is_admin("admin-secret")
    assert not auth.is_admin("wrong")
    ui = auth.create_ui_token()
    assert auth.is_ui(ui)
    assert not auth.is_ui("admin-secret")
    assert len(ui) >= 32
