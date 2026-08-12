package pixiv

import "testing"

func TestValidAPIHost(t *testing.T) {
	valid := []string{
		"https://app-api.pixiv.net/v1/illust/recommended?filter=for_ios",
		"https://app-api.pixiv.net/v2/illust/related?illust_id=123&filter=for_ios",
		"https://app-api.pixiv.net:443/v1/illust/ranking",
	}
	for _, u := range valid {
		if !validAPIHost(u) {
			t.Errorf("validAPIHost(%q) = false, want true", u)
		}
	}

	invalid := []string{
		"",
		"http://app-api.pixiv.net/v1/x", // plaintext
		"https://evil.example.com/app-api.pixiv.net", // path trick
		"https://app-api.pixiv.net.evil.com/v1/x",    // suffix domain
		"https://app-api.pixiv.net:444/v1/x",         // non-default port
		"https://user@evil.com/app-api.pixiv.net",    // userinfo
		"https://app-api.pixiv.net@evil.com/v1/x",    // userinfo as host
		"https://i.pximg.net/v1/x",                   // wrong pixiv host
		"https://www.pixiv.net/ajax/top/illust",      // web host is not the API
		"//app-api.pixiv.net/v1/x",                   // scheme-relative
		"https://app-api.pixiv.net.evil.com./v1/x",   // trailing-dot suffix
		"not a url",
		"https://app-api.pixiv.net/v1/\nx", // raw control char in path
	}
	for _, u := range invalid {
		if validAPIHost(u) {
			t.Errorf("validAPIHost(%q) = true, want false", u)
		}
	}
}

func TestValidImageURL(t *testing.T) {
	valid := []string{
		"https://i.pximg.net/c/360x360_70/img-master/img/2026/08/10/00/00/24/148227434_p0_square1200.jpg",
		"https://img.pximg.net/img/1.jpg",
		"https://s.pximg.net/common/logo.png",
		// userinfo on a VALID host is inert (Go never sends it as auth) — accepted
		"https://user@i.pximg.net/img/1.jpg",
	}
	for _, u := range valid {
		if !validImageURL(u) {
			t.Errorf("validImageURL(%q) = false, want true", u)
		}
	}

	invalid := []string{
		"",
		"http://i.pximg.net/img/1.jpg",        // plaintext
		"https://evil.example.com/1.jpg",      // arbitrary host
		"https://i.pximg.net:8080/img/1.jpg",  // non-default port
		"https://i.pximg.net.evil.com/1.jpg",  // suffix domain
		"https://www.pixiv.net/img/1.jpg",     // web host is not the CDN
		"https://app-api.pixiv.net/img/1.jpg", // API host is not the CDN
		"file:///etc/passwd",                  // local file
		"https://127.0.0.1/1.jpg",             // loopback
	}
	for _, u := range invalid {
		if validImageURL(u) {
			t.Errorf("validImageURL(%q) = true, want false", u)
		}
	}
}

func TestValidID(t *testing.T) {
	valid := []string{"1", "123456789", "148227434"}
	for _, id := range valid {
		if !validID(id) {
			t.Errorf("validID(%q) = false, want true", id)
		}
	}

	invalid := []string{"", "abc", "12a", "-1", "+1", "1.5", "1e3", "１２３", " 1", "1 "}
	for _, id := range invalid {
		if validID(id) {
			t.Errorf("validID(%q) = true, want false", id)
		}
	}
}
