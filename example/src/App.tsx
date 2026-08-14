import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

type Category = "work" | "personal";

function App() {
	const [text, setText] = useState("");
	const [category, setCategory] = useState<Category>("work");
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<"" | Category>("");

	const addNote = useMutation(api.example.addNote);
	const deleteNote = useMutation(api.example.deleteNote);
	const results = useQuery(
		api.example.searchNotes,
		search ? { query: search, category: filter || undefined } : "skip",
	);
	const allNotes = useQuery(api.example.listNotes);
	const notes = search ? results?.page : allNotes;

	const handleAdd = () => {
		if (!text.trim()) return;
		void addNote({ text, category });
		setText("");
	};

	return (
		<div style={{ maxWidth: 640, margin: "0 auto", padding: "2rem", textAlign: "left" }}>
			<h1>convex-improved-search</h1>
			<p style={{ opacity: 0.7 }}>
				Exact substring search that works for CJK — try adding notes in
				Chinese and searching any two characters from the middle.
			</p>

			<div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
				<input
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="新增備註，例如：回程過磅費，司機墊付停車場費"
					style={{ flex: 1, padding: "0.5rem" }}
					onKeyDown={(event) => event.key === "Enter" && handleAdd()}
				/>
				<select
					value={category}
					onChange={(event) => setCategory(event.target.value as Category)}
				>
					<option value="work">work</option>
					<option value="personal">personal</option>
				</select>
				<button onClick={handleAdd}>Add</button>
			</div>

			<div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
				<input
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="搜尋任意子串，例如：停車"
					style={{ flex: 1, padding: "0.5rem" }}
				/>
				<select
					value={filter}
					onChange={(event) => setFilter(event.target.value as "" | Category)}
				>
					<option value="">all</option>
					<option value="work">work</option>
					<option value="personal">personal</option>
				</select>
			</div>

			<ul style={{ listStyle: "none", padding: 0 }}>
				{(notes ?? []).map((note) => (
					<li
						key={note._id}
						style={{
							display: "flex",
							gap: "0.5rem",
							alignItems: "center",
							padding: "0.5rem",
							marginBottom: "0.5rem",
							backgroundColor: "rgba(128, 128, 128, 0.1)",
							borderRadius: 4,
						}}
					>
						<span style={{ flex: 1 }}>{note.text}</span>
						<span style={{ opacity: 0.6, fontSize: "0.8rem" }}>{note.category}</span>
						<button onClick={() => void deleteNote({ noteId: note._id })}>×</button>
					</li>
				))}
			</ul>
			{search && results && !results.isDone && (
				<p style={{ opacity: 0.6, fontSize: "0.85rem" }}>
					部分結果（掃描預算內），繼續分頁可取得其餘命中。
				</p>
			)}
		</div>
	);
}

export default App;
