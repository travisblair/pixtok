package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// illust is the standard frontend shape shared by both web AJAX transforms.
type illust struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
	User  struct {
		ID               string `json:"id"`
		Name             string `json:"name"`
		Account          string `json:"account"`
		ProfileImageURLs struct {
			Medium string `json:"medium"`
		} `json:"profile_image_urls"`
	} `json:"user"`
	ImageURLs      map[string]string `json:"image_urls"`
	MetaPages      []metaPage        `json:"meta_pages,omitempty"`
	PageCount      int               `json:"page_count"`
	TotalBookmarks int               `json:"total_bookmarks"`
	TotalView      int               `json:"total_view"`
	IsBookmarked   bool              `json:"is_bookmarked"`
	CreateDate     string            `json:"create_date"`
	Caption        string            `json:"caption"`
	Tags           []illustTag       `json:"tags,omitempty"`
	XRestrict      int               `json:"x_restrict,omitempty"`
	AIType         int               `json:"ai_type,omitempty"`
}

type metaPage struct {
	ImageURLs struct {
		SquareMedium string `json:"square_medium"`
		Medium       string `json:"medium"`
		Large        string `json:"large"`
	} `json:"image_urls"`
}

type illustTag struct {
	Name           string `json:"name"`
	TranslatedName string `json:"translated_name"`
	IsEmphasized   bool   `json:"is_emphasized"`
}

// illustTypeString maps pixiv's web illustType discriminator
// (0=illust, 1=manga, 2=ugoira) to the FE type string.
func illustTypeString(it int) string {
	switch it {
	case 2:
		return "ugoira"
	case 1:
		return "manga"
	default:
		return "illust"
	}
}

type feedResponse struct {
	Illusts []illust `json:"illusts"`
	NextURL *string  `json:"next_url"`
}

// tagTranslationMap is pixiv's response-level {tagName: {en}} map carried
// by search and top-firehose responses. Work items themselves carry only
// raw tag strings — the map is the only translation source for them.
type tagTranslationMap map[string]struct {
	En string `json:"en"`
}

// applyTagTranslations fills TranslatedName on works' tags from a
// response-level tagTranslation map. Works without a mapping keep their
// raw name (the FE chip just renders no translation line).
func applyTagTranslations(works []illust, tr tagTranslationMap) {
	if len(tr) == 0 {
		return
	}
	for i := range works {
		for j := range works[i].Tags {
			if t, ok := tr[works[i].Tags[j].Name]; ok && t.En != "" {
				works[i].Tags[j].TranslatedName = t.En
			}
		}
	}
}

// transformTopIllust converts Pixiv's web AJAX /ajax/top/illust response
// (the Illustrations tab firehose) to the standard FeedResponse format.
func transformTopIllust(raw []byte) ([]byte, error) {
	var src struct {
		Body struct {
			Thumbnails struct {
				Illust []struct {
					ID           string `json:"id"`
					Title        string `json:"title"`
					IllustType   int    `json:"illustType"`
					UserID       string `json:"userId"`
					UserName     string `json:"userName"`
					PageCount    int    `json:"pageCount"`
					BookmarkData *struct {
						ID string `json:"id"`
					} `json:"bookmarkData"`
					Urls        map[string]string `json:"urls"`
					ProfileImg  string            `json:"profileImageUrl"`
					Tags        []string          `json:"tags"`
					Description string            `json:"description"`
					CreateDate  string            `json:"createDate"`
				} `json:"illust"`
			} `json:"thumbnails"`
			TagTranslation tagTranslationMap `json:"tagTranslation"`
		} `json:"body"`
	}

	if err := json.Unmarshal(raw, &src); err != nil {
		return nil, err
	}

	out := feedResponse{Illusts: make([]illust, 0, 30)}

	for _, srcIll := range src.Body.Thumbnails.Illust {
		if len(out.Illusts) >= 30 {
			break
		}
		ill := illust{
			ID:             srcIll.ID,
			Title:          srcIll.Title,
			Type:           illustTypeString(srcIll.IllustType),
			PageCount:      srcIll.PageCount,
			TotalBookmarks: 0,
			TotalView:      0,
			IsBookmarked:   srcIll.BookmarkData != nil,
			CreateDate:     srcIll.CreateDate,
			Caption:        srcIll.Description,
			ImageURLs:      srcIll.Urls,
		}
		ill.User.ID = srcIll.UserID
		ill.User.Name = srcIll.UserName
		ill.User.Account = srcIll.UserName
		ill.User.ProfileImageURLs.Medium = srcIll.ProfileImg

		// Map raw web tag strings so the firehose is tag-filterable.
		for _, tag := range srcIll.Tags {
			ill.Tags = append(ill.Tags, illustTag{Name: tag})
		}

		// Ensure we have at least "large" for compatibility with FeedCard
		if ill.ImageURLs == nil {
			ill.ImageURLs = make(map[string]string)
		}
		// If no "large" key exists, use the largest available
		if _, ok := ill.ImageURLs["large"]; !ok {
			for _, size := range []string{"1200x1200", "540x540", "360x360", "250x250"} {
				if u, ok := ill.ImageURLs[size]; ok {
					ill.ImageURLs["large"] = u
					break
				}
			}
		}

		out.Illusts = append(out.Illusts, ill)
	}

	applyTagTranslations(out.Illusts, src.Body.TagTranslation)

	return json.Marshal(out)
}

// transformStreet converts POST /ajax/street/v2/main responses (the modern
// personalized homepage) to the standard FeedResponse format. Non-artwork
// blocks (separators, promos, ranking carousels, pixivision, novels) are
// dropped. next_url carries the nextParams cursor JSON verbatim; the client
// POSTs it back for the next page.
func transformStreet(raw []byte) ([]byte, error) {
	var src struct {
		// Pixiv error envelope: a 200 response with {"error":true}
		// (auth expired, rate limited) must surface as an error, not
		// an empty feed.
		Error   bool   `json:"error"`
		Message string `json:"message"`
		Body    struct {
			Contents []struct {
				Kind       string `json:"kind"`
				Thumbnails []struct {
					Type        string `json:"type"`
					IllustType  int    `json:"illustType"`
					PageCount   int    `json:"pageCount"`
					ID          string `json:"id"`
					Title       string `json:"title"`
					UserID      string `json:"userId"`
					UserName    string `json:"userName"`
					ProfileImg  string `json:"profileImageUrl"`
					Description string `json:"description"`
					CreateDate  string `json:"createDate"`
					XRestrict   int    `json:"xRestrict"`
					AIType      int    `json:"aiType"`
					Tags        []struct {
						Name           string `json:"name"`
						TranslatedName string `json:"translatedName"`
						IsEmphasized   bool   `json:"isEmphasized"`
					} `json:"tags"`
					Pages []struct {
						Width  int `json:"width"`
						Height int `json:"height"`
						Urls   struct {
							Large  string `json:"1200x1200_standard"`
							Medium string `json:"540x540"`
							Square string `json:"360x360"`
						} `json:"urls"`
					} `json:"pages"`
				} `json:"thumbnails"`
			} `json:"contents"`
			NextParams json.RawMessage `json:"nextParams"`
		} `json:"body"`
	}

	if err := json.Unmarshal(raw, &src); err != nil {
		return nil, err
	}
	if src.Error {
		msg := src.Message
		if msg == "" {
			msg = "pixiv reported an error"
		}
		return nil, fmt.Errorf("street: %s", msg)
	}

	out := feedResponse{Illusts: make([]illust, 0, 60)}

	for _, block := range src.Body.Contents {
		if block.Kind != "illust" && block.Kind != "manga" {
			continue // separators, ranking carousels, promos, novels
		}
		if len(block.Thumbnails) == 0 {
			continue
		}
		thumb := block.Thumbnails[0]

		// Street thumbnails carry a `type` string (illust/manga — ugoira
		// works are labelled illust there) and, when present, the
		// authoritative illustType discriminator. Prefer illustType.
		typ := thumb.Type
		if thumb.IllustType != 0 {
			typ = illustTypeString(thumb.IllustType)
		}

		ill := illust{
			ID:             thumb.ID,
			Title:          thumb.Title,
			Type:           typ,
			PageCount:      thumb.PageCount,
			CreateDate:     thumb.CreateDate,
			Caption:        thumb.Description,
			XRestrict:      thumb.XRestrict,
			AIType:         thumb.AIType,
			ImageURLs:      map[string]string{},
			TotalBookmarks: 0,
			TotalView:      0,
			IsBookmarked:   false,
		}
		if ill.Type == "" {
			ill.Type = "illust"
		}
		ill.User.ID = thumb.UserID
		ill.User.Name = thumb.UserName
		ill.User.Account = thumb.UserName
		ill.User.ProfileImageURLs.Medium = thumb.ProfileImg

		for _, tag := range thumb.Tags {
			ill.Tags = append(ill.Tags, illustTag{
				Name:           tag.Name,
				TranslatedName: tag.TranslatedName,
				IsEmphasized:   tag.IsEmphasized,
			})
		}

		if len(thumb.Pages) > 0 {
			first := thumb.Pages[0]
			ill.ImageURLs["square_medium"] = first.Urls.Square
			ill.ImageURLs["medium"] = first.Urls.Medium
			ill.ImageURLs["large"] = first.Urls.Large
		}

		for _, page := range thumb.Pages {
			var mp metaPage
			mp.ImageURLs.SquareMedium = page.Urls.Square
			mp.ImageURLs.Medium = page.Urls.Medium
			mp.ImageURLs.Large = page.Urls.Large
			ill.MetaPages = append(ill.MetaPages, mp)
		}
		if len(ill.MetaPages) <= 1 {
			ill.MetaPages = nil // single-page: let FeedCard use image_urls
		}

		out.Illusts = append(out.Illusts, ill)
	}

	if len(src.Body.NextParams) > 0 && string(src.Body.NextParams) != "null" {
		next := string(src.Body.NextParams)
		out.NextURL = &next
	}

	return json.Marshal(out)
}

// deriveLarge converts a pixiv thumbnail URL to the full-size master1200
// URL. The /c/<size>_<quality>/ prefix is a resize-proxy path segment — it
// can be dropped to reach the underlying file. Known paths in the wild:
// img-master (the classic thumbs) and custom-thumb (pixiv's newer scheme
// for AI/custom-cropped works — their _custom1200 variant IS the full
// size, so it needs no suffix rewrite):
//
//	https://i.pximg.net/c/250x250_80_a2/img-master/img/<path>/<id>_square1200.jpg
//	-> https://i.pximg.net/img-master/img/<path>/<id>_master1200.jpg
//
//	https://i.pximg.net/c/250x250_80_a2/custom-thumb/img/<path>/<id>_custom1200.jpg
//	-> https://i.pximg.net/custom-thumb/img/<path>/<id>_custom1200.jpg
//
// ok is false when the URL doesn't match the thumbnail pattern — callers
// must NOT synthesize master1200/meta_pages URLs from it (search cards
// used to pass the 250px square through as `large`, and ugoira posters
// rendered as big square blocks that snapped to the real ratio on play).
var cThumbPrefixRe = regexp.MustCompile(`^(.+)/c/[^/]+/((?:img-master|custom-thumb)/.+)$`)

func deriveLarge(thumb string) (url string, ok bool) {
	match := cThumbPrefixRe.FindStringSubmatch(thumb)
	if match == nil {
		return thumb, false
	}
	size := match[1] + "/" + match[2]
	if strings.HasSuffix(size, "_square1200.jpg") {
		return strings.Replace(size, "_square1200.jpg", "_master1200.jpg", 1), true
	}
	return size, true
}

// pageThumb derives the i-th page's square thumbnail from a page-0
// recommend/init thumbnail (i=0 returns the input unchanged).
func pageThumb(thumb string, i int) string {
	if i == 0 {
		return thumb
	}
	return strings.Replace(thumb, "_p0_square1200.jpg", fmt.Sprintf("_p%d_square1200.jpg", i), 1)
}

// transformWorkRecommend converts GET /ajax/illust/{id}/recommend/init
// (per-work "Related works", web field style) to the standard
// FeedResponse format. The payload carries only square thumbnails; large
// URLs are derived via deriveLarge, and multi-page works get meta_pages
// generated for each page index.
// webIllust is the raw web-AJAX work item shape shared by the recommend
// (recommend/init), newest (illust/new), and related-lite endpoints:
// string ids, a square `url` thumbnail, string tags, userName (no
// account field), profileImageUrl, pageCount, aiType.
type webIllust struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Type         string   `json:"type"`
	IllustType   int      `json:"illustType"`
	UserID       string   `json:"userId"`
	UserName     string   `json:"userName"`
	ProfileImg   string   `json:"profileImageUrl"`
	URL          string   `json:"url"`
	PageCount    int      `json:"pageCount"`
	Width        int      `json:"width"`
	Height       int      `json:"height"`
	CreateDate   string   `json:"createDate"`
	Description  string   `json:"description"`
	Tags         []string `json:"tags"`
	XRestrict    int      `json:"xRestrict"`
	AIType       int      `json:"aiType"`
	BookmarkData *struct {
		ID string `json:"id"`
	} `json:"bookmarkData"`
}

// mapWebIllusts converts raw web-AJAX work items to the standard illust
// shape: the square thumbnail maps through deriveLarge, multi-page works
// get synthetic meta_pages, raw string tags become tag objects.
func mapWebIllusts(items []webIllust, maxWorks int) []illust {
	const maxPages = 200 // a corrupt pageCount could OOM the meta_pages loop

	out := make([]illust, 0, len(items))
	for _, item := range items {
		if len(out) >= maxWorks {
			break
		}
		// Web AJAX works carry NO type string — illustType is the
		// authoritative discriminator (0=illust, 1=manga, 2=ugoira).
		// The old fallback only mapped 1→manga and dropped 2 into
		// "illust", so every ugoira work in search/newest/recs
		// rendered as a static card and the ▶ player never mounted.
		typ := item.Type
		switch {
		case item.IllustType == 2:
			typ = "ugoira"
		case item.IllustType == 1:
			typ = "manga"
		case typ == "":
			typ = "illust"
		}

		large, ok := deriveLarge(item.URL)

		ill := illust{
			ID:             item.ID,
			Title:          item.Title,
			Type:           typ,
			PageCount:      item.PageCount,
			CreateDate:     item.CreateDate,
			Caption:        item.Description,
			XRestrict:      item.XRestrict,
			AIType:         item.AIType,
			IsBookmarked:   item.BookmarkData != nil,
			TotalBookmarks: 0,
			TotalView:      0,
			ImageURLs: map[string]string{
				"square_medium": item.URL,
				"medium":        item.URL,
				"large":         large,
			},
		}
		ill.User.ID = item.UserID
		ill.User.Name = item.UserName
		ill.User.Account = item.UserName
		ill.User.ProfileImageURLs.Medium = item.ProfileImg

		for _, tag := range item.Tags {
			ill.Tags = append(ill.Tags, illustTag{Name: tag})
		}

		// Multi-page works: generate a meta page per index. Only when
		// the thumbnail matched the known CDN pattern — otherwise the
		// derived URLs would all be the same page-0 square and the
		// reader would silently show one tiny image on every page.
		// Single pages stay nil so FeedCard uses image_urls directly.
		pages := item.PageCount
		if pages > maxPages {
			pages = maxPages
		}
		if ok && pages > 1 {
			for i := 0; i < pages; i++ {
				var mp metaPage
				mp.ImageURLs.SquareMedium = pageThumb(item.URL, i)
				mp.ImageURLs.Medium = pageThumb(item.URL, i)
				mp.ImageURLs.Large = strings.Replace(
					large, "_p0_master1200.jpg", fmt.Sprintf("_p%d_master1200.jpg", i), 1,
				)
				ill.MetaPages = append(ill.MetaPages, mp)
			}
		}

		out = append(out, ill)
	}
	return out
}

// transformWorkRecommend converts GET /ajax/illust/{id}/recommend/init
// responses (the site's per-work "Related works") to FeedResponse.
func transformWorkRecommend(raw []byte) ([]byte, error) {
	var src struct {
		Body struct {
			Illusts []webIllust `json:"illusts"`
		} `json:"body"`
	}

	if err := json.Unmarshal(raw, &src); err != nil {
		return nil, err
	}

	out := feedResponse{Illusts: mapWebIllusts(src.Body.Illusts, 200)}
	return json.Marshal(out)
}

// transformNewest converts GET /ajax/illust/new responses (the
// new_illust.php firehose) to FeedResponse. Pagination is the lastId
// cursor; next_url re-hits /api/newest with it so the FE can fetch the
// continuation through the same proxy.
func transformNewest(raw []byte, r18 bool) ([]byte, error) {
	var src struct {
		Body struct {
			Illusts []webIllust `json:"illusts"`
			LastID  string      `json:"lastId"`
		} `json:"body"`
	}

	if err := json.Unmarshal(raw, &src); err != nil {
		return nil, err
	}

	out := feedResponse{Illusts: mapWebIllusts(src.Body.Illusts, 60)}
	if src.Body.LastID != "" {
		next := fmt.Sprintf("/api/newest?r18=%t&lastId=%s", r18, src.Body.LastID)
		out.NextURL = &next
	}
	return json.Marshal(out)
}

// searchArtworksResponse is the search results feed: the result grid plus
// the tag's popular block (the site's "recommendations" on search pages)
// and related tags with translations. NextURL is built by the handler
// (it owns the page counter).
type searchArtworksResponse struct {
	Illusts     []illust    `json:"illusts"`
	Total       int         `json:"total"`
	LastPage    int         `json:"last_page"`
	Page        int         `json:"page"`
	NextURL     *string     `json:"next_url"`
	Popular     []illust    `json:"popular"`
	RelatedTags []illustTag `json:"related_tags"`
}

// transformSearchArtworks converts GET /ajax/search/artworks/{word} (body
// key "illustManga") and GET /ajax/search/illustrations/{word} (body key
// "illust") responses to the search feed shape.
func transformSearchArtworks(raw []byte) (searchArtworksResponse, error) {
	var src struct {
		Error bool `json:"error"`
		Body  struct {
			IllustManga struct {
				Data     []webIllust `json:"data"`
				Total    int         `json:"total"`
				LastPage int         `json:"lastPage"`
			} `json:"illustManga"`
			// The /illustrations route (illust-only work type) returns
			// the same inner shape under the "illust" key.
			Illust struct {
				Data     []webIllust `json:"data"`
				Total    int         `json:"total"`
				LastPage int         `json:"lastPage"`
			} `json:"illust"`
			Popular struct {
				Recent    []webIllust `json:"recent"`
				Permanent []webIllust `json:"permanent"`
			} `json:"popular"`
			RelatedTags    []string          `json:"relatedTags"`
			TagTranslation tagTranslationMap `json:"tagTranslation"`
		} `json:"body"`
	}

	if err := json.Unmarshal(raw, &src); err != nil {
		return searchArtworksResponse{}, err
	}
	if src.Error {
		return searchArtworksResponse{}, fmt.Errorf("pixiv search error")
	}

	// The artworks endpoint reports under illustManga; illustrations
	// under illust. An empty illustManga block (zero-result or the wrong
	// endpoint) falls back to illust — both are zero structs on a
	// legitimate empty page, so the fallback is always safe.
	list := src.Body.IllustManga
	if len(list.Data) == 0 && list.Total == 0 && len(src.Body.Illust.Data) > 0 {
		list = src.Body.Illust
	}

	// Popular block: recent first, then permanent (the site's order).
	popular := append(append([]webIllust{}, src.Body.Popular.Recent...), src.Body.Popular.Permanent...)

	related := make([]illustTag, 0, len(src.Body.RelatedTags))
	for _, tag := range src.Body.RelatedTags {
		rt := illustTag{Name: tag}
		if tr, ok := src.Body.TagTranslation[tag]; ok && tr.En != "" {
			rt.TranslatedName = tr.En
		}
		related = append(related, rt)
	}

	illusts := mapWebIllusts(list.Data, 60)
	pop := mapWebIllusts(popular, 20)
	applyTagTranslations(illusts, src.Body.TagTranslation)
	applyTagTranslations(pop, src.Body.TagTranslation)

	return searchArtworksResponse{
		Illusts:     illusts,
		Total:       list.Total,
		LastPage:    list.LastPage,
		Popular:     pop,
		RelatedTags: related,
	}, nil
}

// userSearchResult is one user row in the search response, with up to
// three of their most recent works as previews.
type userSearchResult struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Avatar     string   `json:"avatar"`
	Premium    bool     `json:"premium"`
	IsFollowed bool     `json:"is_followed"`
	Previews   []illust `json:"previews"`
}

type searchUsersResponse struct {
	Users   []userSearchResult `json:"users"`
	Total   int                `json:"total"`
	Page    int                `json:"page"`
	NextURL *string            `json:"next_url"`
}

// transformSearchUsers converts GET /ajax/search/users responses to the
// user search shape: each user row carries their sample works (the site
// shows each result's recent illustrations).
func transformSearchUsers(raw []byte) (searchUsersResponse, error) {
	var src struct {
		Error bool `json:"error"`
		Body  struct {
			Users []struct {
				UserID     string `json:"userId"`
				Name       string `json:"name"`
				Image      string `json:"image"`
				Premium    bool   `json:"premium"`
				IsFollowed bool   `json:"isFollowed"`
			} `json:"users"`
			Thumbnails struct {
				Illust []webIllust `json:"illust"`
			} `json:"thumbnails"`
			Page struct {
				WorkIDs map[string][]struct {
					ID   string `json:"id"`
					Type string `json:"type"`
				} `json:"workIds"`
				Total int `json:"total"`
			} `json:"page"`
		} `json:"body"`
	}

	if err := json.Unmarshal(raw, &src); err != nil {
		return searchUsersResponse{}, err
	}
	if src.Error {
		return searchUsersResponse{}, fmt.Errorf("pixiv user search error")
	}

	byID := make(map[string]webIllust, len(src.Body.Thumbnails.Illust))
	for _, work := range src.Body.Thumbnails.Illust {
		byID[work.ID] = work
	}

	out := searchUsersResponse{Total: src.Body.Page.Total}
	for _, user := range src.Body.Users {
		row := userSearchResult{ID: user.UserID, Name: user.Name, Avatar: user.Image, Premium: user.Premium, IsFollowed: user.IsFollowed}
		if ids, ok := src.Body.Page.WorkIDs[user.UserID]; ok {
			previews := make([]webIllust, 0, 3)
			for _, wid := range ids {
				if w, ok := byID[wid.ID]; ok {
					previews = append(previews, w)
				}
				if len(previews) >= 3 {
					break
				}
			}
			row.Previews = mapWebIllusts(previews, 3)
		}
		out.Users = append(out.Users, row)
	}
	return out, nil
}

// bookmarkPageEnvelope is the raw web-AJAX bookmarks page response
// (crawl-verified Aug 2026): {error, message, body:{works[], total}}.
type bookmarkPageEnvelope struct {
	Error   bool   `json:"error"`
	Message string `json:"message"`
	Body    struct {
		Works []webIllust `json:"works"`
		Total int         `json:"total"`
	} `json:"body"`
}

// transformBookmarkPage converts a bookmarks page response to the
// standard FeedResponse. Pagination is a blind offset against total, so
// next_url is built locally as a self-referential /api/bookmarks URL and
// null once offset+limit reaches total.
func transformBookmarkPage(raw []byte, tag string, offset, limit int, order string) ([]byte, error) {
	var env bookmarkPageEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	if env.Error {
		return nil, fmt.Errorf("pixiv bookmark page: %s", env.Message)
	}
	out := feedResponse{Illusts: mapWebIllusts(env.Body.Works, limit)}
	if next := offset + limit; next < env.Body.Total {
		nextURL := fmt.Sprintf("/api/bookmarks?tag=%s&offset=%d&order=%s", url.QueryEscape(tag), next, order)
		out.NextURL = &nextURL
	}
	return json.Marshal(out)
}

// bookmarkTagsEnvelope is the raw tags response (crawl-verified):
// {error, message, body:{public:[{tag,cnt}], private:[{tag,cnt}]}}.
type bookmarkTagsEnvelope struct {
	Error bool `json:"error"`
	Body  struct {
		Public  []bookmarkTag `json:"public"`
		Private []bookmarkTag `json:"private"`
	} `json:"body"`
}

type bookmarkTag struct {
	Tag string `json:"tag"`
	Cnt int    `json:"cnt"`
}

// transformBookmarkTags maps the tags endpoint to
// {public:[{name,count}], private:[{name,count}]}.
func transformBookmarkTags(raw []byte) ([]byte, error) {
	var env bookmarkTagsEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	if env.Error {
		return nil, fmt.Errorf("pixiv bookmark tags error")
	}
	type outTag struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	out := struct {
		Public  []outTag `json:"public"`
		Private []outTag `json:"private"`
	}{
		Public:  make([]outTag, 0, len(env.Body.Public)),
		Private: make([]outTag, 0, len(env.Body.Private)),
	}
	for _, tag := range env.Body.Public {
		out.Public = append(out.Public, outTag{Name: tag.Tag, Count: tag.Cnt})
	}
	for _, tag := range env.Body.Private {
		out.Private = append(out.Private, outTag{Name: tag.Tag, Count: tag.Cnt})
	}
	return json.Marshal(out)
}
