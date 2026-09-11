package main

import (
	"encoding/json"
	"testing"
)

// Regression: pixiv's web-AJAX id encodings are inconsistent ACROSS
// endpoints, not just bookmarks — /ajax/top/illust thumbnails and
// /ajax/search/users carry the same mixed string/number ids (Sept 2026
// rollout). Strict string fields decoded those payloads as errors and
// 502'd the whole feed, so both transforms must accept both encodings
// and normalize to string like every other web-AJAX transform
// (webIllust, street thumbnails).

func TestTransformTopIllustToleratesNumericIDs(t *testing.T) {
	// id AND userId numeric: both ride the same thumbnail payload and
	// both must decode (mirrors transformStreet's flexID pair).
	raw := `{"error":false,"body":{"thumbnails":{"illust":[
		{"id":12345,"title":"NumID","illustType":0,"pageCount":1,
		 "userId":9,"userName":"Alice","profileImageUrl":"https://i.pximg.net/p1",
		 "urls":{"large":"https://i.pximg.net/l1"}}
	]}}}`

	out, err := transformTopIllust([]byte(raw))
	if err != nil {
		t.Fatalf("transformTopIllust with numeric id/userId: %v", err)
	}
	var resp struct {
		Illusts []struct {
			ID   string `json:"id"`
			User struct {
				ID string `json:"id"`
			} `json:"user"`
		} `json:"illusts"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	if len(resp.Illusts) != 1 {
		t.Fatalf("expected 1 illust, got %d", len(resp.Illusts))
	}
	if resp.Illusts[0].ID != "12345" {
		t.Fatalf("numeric top-illust id not normalized: %q", resp.Illusts[0].ID)
	}
	if resp.Illusts[0].User.ID != "9" {
		t.Fatalf("numeric top-illust userId not normalized: %q", resp.Illusts[0].User.ID)
	}
}

func TestTransformSearchUsersToleratesNumericUserID(t *testing.T) {
	raw := `{"error":false,"body":{
		"users":[
			{"userId":77,"name":"User One","image":"https://i.pximg.net/u1.jpg","premium":false,"isFollowed":false}
		],
		"thumbnails":{"illust":[
			{"id":"300","title":"Their work","illustType":0,"pageCount":1,
			 "url":"https://i.pximg.net/c/360x360_70/img-master/img/x/300_p0_square1200.jpg",
			 "userId":77,"userName":"User One"}
		]},
		"page":{"workIds":{"77":[{"id":"300","type":"illust"}]},"total":1}
	}}`

	resp, err := transformSearchUsers([]byte(raw))
	if err != nil {
		t.Fatalf("transformSearchUsers with numeric userId: %v", err)
	}
	if len(resp.Users) != 1 {
		t.Fatalf("expected 1 user, got %d", len(resp.Users))
	}
	if resp.Users[0].ID != "77" {
		t.Fatalf("numeric userId not normalized: %q", resp.Users[0].ID)
	}
	// The workIds lookup keys on the string form — the numeric userId
	// must still resolve the user's previews (a broken lookup silently
	// renders artist rows with no works).
	if len(resp.Users[0].Previews) != 1 || resp.Users[0].Previews[0].ID != "300" {
		t.Fatalf("previews not resolved for numeric userId: %+v", resp.Users[0].Previews)
	}
}
